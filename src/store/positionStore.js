/**
 * @file positionStore.js
 * @description 做市商期权持仓矩阵存储与更新管理器。
 * 负责管理各标的资产 (Ticker) 的期权持仓，并支持开盘利用 Benzinga 全期权链数据进行底仓初始化，
 * 以及盘中根据交易流水进行增量异步修正，避免高频读写冲突。
 */

const { calculateBSGreeks, calculateImpliedVolatility } = require('../calculator/bsCalculator');
const { calculateT, calculateDayT, determineTradeDirection } = require('../utils/sharedUtils');

class PositionStore {
  constructor(config = {}) {
    // 内存持仓字典：{ [ticker]: { [optionSymbol]: optionContractObject } }
    this.store = {};
    
    // 默认配置
    this.oiFactor = config.oiFactor !== undefined ? config.oiFactor : 0.5;
  }

  /**
   * 清空存储器
   */
  clear() {
    this.store = {};
  }

  /**
   * 使用 Benzinga 完整期权链数据初始化指定 Ticker 的持仓矩阵
   * @param {string} ticker - 标的资产代码 (如 "AAPL")
   * @param {object} benzingaChain - Benzinga 期权链 API 响应对象
   */
  initializeChain(ticker, benzingaChain, currentDateStr = new Date().toISOString().split('T')[0]) {
    const uppercaseTicker = ticker.toUpperCase();
    this.store[uppercaseTicker] = {};

    if (!benzingaChain || !benzingaChain.optionChains) {
      return;
    }

    const tickerChain = benzingaChain.optionChains.find(
      c => c.symbol.toUpperCase() === uppercaseTicker
    );

    if (!tickerChain || !tickerChain.chains) {
      return;
    }

    // 遍历每一个到期日的分组
    tickerChain.chains.forEach(expiryGroup => {
      const expirationDateStr = this._parseExpirationDate(expiryGroup.mmy); // 将 YYYYMMDD 转为 YYYY-MM-DD
      
      // 过滤到期日，最多两个星期内（14天）
      // Bug #14: 显式指定美东时区防止时区歧义
      const expDate = new Date(expirationDateStr + 'T00:00:00-04:00');
      const curDate = new Date(currentDateStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays > 14) {
        return; // 跳过
      }

      // 处理 Calls
      if (expiryGroup.calls) {
        expiryGroup.calls.forEach(opt => {
          this._registerOption(uppercaseTicker, opt, 'CALL', expirationDateStr);
        });
      }

      // 处理 Puts
      if (expiryGroup.puts) {
        expiryGroup.puts.forEach(opt => {
          this._registerOption(uppercaseTicker, opt, 'PUT', expirationDateStr);
        });
      }
    });
  }

  /**
   * 盘中收到大单交易时，增量更新做市商的持仓矩阵
   * @param {string} ticker - 标的资产代码
   * @param {object} trade - 交易数据对象 (格式同 2026-06-18.json 中的记录)
   * @returns {boolean} 是否更新成功
   */
  applyTrade(ticker, trade, currentDateStr = new Date().toISOString().split('T')[0]) {
    const uppercaseTicker = ticker.toUpperCase();
    const symbol = trade.option_symbol;

    // 过滤到期日，最多两个星期内（14天）
    const expirationStr = trade.date_expiration;
    if (expirationStr) {
      // Bug #14: 显式指定美东时区防止时区歧义
      const expDate = new Date(expirationStr + 'T00:00:00-04:00');
      const curDate = new Date(currentDateStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));
      if (diffDays < 0 || diffDays > 14) {
        return false; // 过滤不处理
      }
    }

    // 1. 如果该 Ticker 尚未初始化，则为其创建空字典
    if (!this.store[uppercaseTicker]) {
      this.store[uppercaseTicker] = {};
    }

    // 2. 如果是新发现的期权合约 (可能 API 期权链未覆盖)，先进行动态初始化
    if (!this.store[uppercaseTicker][symbol]) {
      const oi = parseInt(trade.open_interest, 10) || 0;
      const type = trade.put_call.toUpperCase();
      this.store[uppercaseTicker][symbol] = {
        symbol: symbol,
        strike: parseFloat(trade.strike_price),
        type: type,
        expiration: trade.date_expiration,
        openInterest: oi,
        // 根据解耦架构初始化持仓
        structurePosition: type === 'CALL' ? (oi * this.oiFactor) : (-oi * this.oiFactor),
        dealerPosition: -oi * this.oiFactor,
        iv: undefined
      };
    }

    // 3. 计算本笔交易导致的持仓变动量 (PRD Step 2 & 3)
    const size = parseInt(trade.size, 10) || 0;
    const direction = this._determineTradeDirection(trade);
    const contract = this.store[uppercaseTicker][symbol];
    const isCall = contract.type === 'CALL';

    if (direction === 'BUY') {
      // 客户买入，做市商卖出 => 做市商持仓减少
      contract.dealerPosition -= size;
      // 结构层：多头买入 CALL => 多头地形增加；多头买入 PUT => 空头地形增加 (即更加负)
      if (isCall) {
        contract.structurePosition += size;
      } else {
        contract.structurePosition -= size;
      }
    } else if (direction === 'SELL') {
      // 客户卖出，做市商买入 => 做市商持仓增加
      contract.dealerPosition += size;
      // 结构层：多头卖出 CALL => 多头地形减少；多头卖出 PUT => 空头地形减少 (即更加正)
      if (isCall) {
        contract.structurePosition -= size;
      } else {
        contract.structurePosition += size;
      }
    }

    return true;
  }

  /**
   * 获取指定 Ticker 的当前完整持仓矩阵
   * @param {string} ticker - 标的资产代码
   * @returns {Array<object>} 持仓合约数组
   */
  getPositionMatrix(ticker) {
    const uppercaseTicker = ticker.toUpperCase();
    if (!this.store[uppercaseTicker]) {
      return [];
    }
    return Object.values(this.store[uppercaseTicker]);
  }

  /**
   * 根据当前持仓与当前股价，重新计算每个合约的希腊字母和 GEX
   * @param {string} ticker - 标的资产代码
   * @param {number} spot - 当前正股价格
   * @param {number} r - 年化无风险利率 (默认 0.05)
   * @param {string} currentDateStr - 当前计算日期 (YYYY-MM-DD，用于计算剩余期限 T)
   * @param {string} [currentTimeStr="09:30:00"] - 盘中当前时间 (HH:MM:SS)
   * @param {string} [expiryFilter="all"] - 到期日过滤器 (all / 0dte / weekly)
   * @param {object} [greeksConfig] - Clamping 限幅等配置
   * @returns {Array<object>} 计算完 Greeks 和 GEX 后的合约列表
   */
  calculateMatrixGEX(ticker, spot, r, currentDateStr, currentTimeStr = "09:30:00", expiryFilter = "all", greeksConfig = {}) {
    if (!spot) {
      return [];
    }
    const matrix = this.getPositionMatrix(ticker);

    return matrix.map(contract => {
      // 过滤逻辑
      // Bug #14: 显式指定美东时区防止时区歧义
      const expDate = new Date(contract.expiration + 'T00:00:00-04:00');
      const curDate = new Date(currentDateStr + 'T00:00:00-04:00');
      const diffDays = Math.round((expDate - curDate) / (1000 * 60 * 60 * 24));

      // 物理裁剪：最多只保留两星期内（14天）的期权合约
      if (diffDays < 0 || diffDays > 14) {
        return null;
      }

      if (expiryFilter === '0dte' && diffDays !== 0) {
        return null;
      }
      if (expiryFilter === 'weekly' && (diffDays < 1 || diffDays > 5)) {
        return null;
      }

      // 计算日内高频年化剩余期限 T (修复 0DTE T=0 的 Bug)
      // Bug #7: 使用共享工具类计算 T
      const T = calculateT(currentDateStr, currentTimeStr, contract.expiration);

      const marketPrice = contract.midpoint || ((contract.bid + contract.ask) / 2.0) || 0.1;

      // 动态反推实时 IV：使用分钟/秒级 T，供实时 GEX 与 Dealer Pressure 使用
      let ivRealtime = contract.ivRealtime;
      if (ivRealtime === undefined || ivRealtime === null) {
        ivRealtime = calculateImpliedVolatility(spot, contract.strike, T, r, marketPrice, contract.type);
        if (isNaN(ivRealtime) || ivRealtime <= 0.0002) {
          ivRealtime = 0.20; // 实在算不出来的回退默认值为 20%，更贴近真实大盘 (SPY/QQQ) 的底噪 IV
        }
        contract.ivRealtime = ivRealtime;
        contract.iv = ivRealtime; // 兼容旧字段
      }

      // 计算实时 Greeks
      const greeks = calculateBSGreeks(spot, contract.strike, T, r, ivRealtime, contract.type, greeksConfig);

      // 结构层与做市商持仓解耦后，直接利用 structurePosition 进行 GEX 地图计算
      // GEX = structurePosition * Gamma * 100 * Spot^2 * 0.01
      const gex = contract.structurePosition * greeks.gamma * 100 * (spot * spot) * 0.01;

      // 全局地图 GEX：使用静态 OI（即开盘未平仓量）与天级 T/IV
      const T_global = calculateDayT(currentDateStr, contract.expiration);
      let ivGlobal = contract.ivGlobal;
      if (ivGlobal === undefined || ivGlobal === null) {
        ivGlobal = calculateImpliedVolatility(spot, contract.strike, T_global, r, marketPrice, contract.type);
        if (isNaN(ivGlobal) || ivGlobal <= 0.0002) {
          ivGlobal = 0.20;
        }
        contract.ivGlobal = ivGlobal;
      }
      const greeks_global = calculateBSGreeks(spot, contract.strike, T_global, r, ivGlobal, contract.type, greeksConfig);
      const initialPosition = contract.type === 'CALL' ? ((contract.openInterest || 0) * this.oiFactor) : (-(contract.openInterest || 0) * this.oiFactor);
      const gexGlobal = initialPosition * greeks_global.gamma * 100 * (spot * spot) * 0.01;

      return {
        ...contract,
        t: T,
        tGlobal: T_global,
        ivRealtime,
        ivGlobal,
        delta: greeks.delta,
        gamma: greeks.gamma,
        charm: greeks.charm,
        vanna: greeks.vanna,
        deltaGlobal: greeks_global.delta,
        gammaGlobal: greeks_global.gamma,
        charmGlobal: greeks_global.charm,
        vannaGlobal: greeks_global.vanna,
        gex: gex, // 用于实时状态
        gexGlobal: gexGlobal // 用于全局地图
      };
    }).filter(item => item !== null);
  }

  /**
   * 批量初始化指定 Ticker 所有合约的 IV (一次性预计算，彻底消除盘中高频二分法 IV 计算瓶颈)
   * @param {string} ticker - 标的资产代码
   * @param {number} spot - 当前正股价格
   * @param {number} r - 无风险利率
   * @param {string} currentDateStr - 当前日期
   * @param {string} currentTimeStr - 当前时间
   */
  initializeIVs(ticker, spot, r, currentDateStr, currentTimeStr = "09:30:00") {
    if (!spot) {
      return;
    }
    const uppercaseTicker = ticker.toUpperCase();
    const matrix = this.getPositionMatrix(uppercaseTicker);
    
    matrix.forEach(contract => {
      // Bug #7: 使用共享工具类计算 T
      const T = calculateT(currentDateStr, currentTimeStr, contract.expiration);
      const marketPrice = contract.midpoint || ((contract.bid + contract.ask) / 2.0) || 0.1;
      let iv = calculateImpliedVolatility(spot, contract.strike, T, r, marketPrice, contract.type);
      if (isNaN(iv) || iv <= 0.0002) {
        iv = 0.20; // 实在算不出的回退默认值为 20%
      }
      contract.ivRealtime = iv;
      contract.iv = iv;

      const T_global = calculateDayT(currentDateStr, contract.expiration);
      let ivGlobal = calculateImpliedVolatility(spot, contract.strike, T_global, r, marketPrice, contract.type);
      if (isNaN(ivGlobal) || ivGlobal <= 0.0002) {
        ivGlobal = 0.20;
      }
      contract.ivGlobal = ivGlobal;
    });
  }

  /**
   * 内部方法：计算剩余年化时间 T (支持日内秒级衰减)
   * @private
   */
  _calculateT(currentDateStr, currentTimeStr, expirationDateStr) {
    return calculateT(currentDateStr, currentTimeStr, expirationDateStr);
  }

  /**
   * 内部方法：注册期权链合约
   * @private
   */
  _registerOption(ticker, opt, type, expirationStr) {
    const symbol = opt.symbol;
    const oi = parseInt(opt.openInterest, 10) || 0;
    
    // 计算买卖中价
    const bid = parseFloat(opt.bidPrice) || 0;
    const ask = parseFloat(opt.askPrice) || 0;
    const midpoint = (bid + ask) / 2.0;

    this.store[ticker][symbol] = {
      symbol: symbol,
      strike: parseFloat(opt.strike),
      type: type,
      expiration: expirationStr,
      openInterest: oi,
      // 结构层与做市商持仓解耦
      structurePosition: type === 'CALL' ? (oi * this.oiFactor) : (-oi * this.oiFactor),
      dealerPosition: -oi * this.oiFactor,
      bid: bid,
      ask: ask,
      midpoint: midpoint,
      iv: undefined // 设为 undefined，便于后续通过初始化或反推填充
    };
  }

  /**
   * 内部方法：解析 API 返回的 MMY 格式 (YYYYMMDD) 为 YYYY-MM-DD
   * @private
   */
  _parseExpirationDate(mmy) {
    if (!mmy || mmy.length !== 8) return mmy;
    return `${mmy.substring(0, 4)}-${mmy.substring(4, 6)}-${mmy.substring(6, 8)}`;
  }

  /**
   * 内部方法：判定盘中大单交易的方向是客户买入（BUY）还是客户卖出（SELL）
   * @private
   */
  _determineTradeDirection(trade) {
    return determineTradeDirection(trade.execution_estimate, trade.aggressor_ind);
  }

  /**
   * 盘中每分钟用最新期权链更新已有合约的报价，供重算实时 Greeks 使用
   * @param {string} ticker - 标的代码
   * @param {object} benzingaChain - Benzinga 期权链 API 响应对象
   */
  updateChainPrices(ticker, benzingaChain) {
    const uppercaseTicker = ticker.toUpperCase();
    if (!this.store[uppercaseTicker] || !benzingaChain || !benzingaChain.optionChains) {
      return;
    }
    const tickerChain = benzingaChain.optionChains.find(
      c => c.symbol.toUpperCase() === uppercaseTicker
    );
    if (!tickerChain || !tickerChain.chains) {
      return;
    }
    tickerChain.chains.forEach(expiryGroup => {
      const updateContracts = (opts) => {
        if (!opts) return;
        opts.forEach(opt => {
          const symbol = opt.symbol;
          const contract = this.store[uppercaseTicker][symbol];
          if (contract) {
            const bid = parseFloat(opt.bidPrice) || 0;
            const ask = parseFloat(opt.askPrice) || 0;
            contract.bid = bid;
            contract.ask = ask;
            contract.midpoint = (bid + ask) / 2.0;
            // 报价变了，强制清除缓存的旧 IV，使后续计算重新反推
            contract.iv = undefined;
            contract.ivRealtime = undefined;
            contract.ivGlobal = undefined;
          }
        });
      };
      updateContracts(expiryGroup.calls);
      updateContracts(expiryGroup.puts);
    });
  }
}

module.exports = PositionStore;
