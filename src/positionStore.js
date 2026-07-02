/**
 * @file positionStore.js
 * @description 期权持仓矩阵存储与更新管理器。
 * 负责管理各标的资产 (Ticker) 的期权持仓，并支持开盘利用 Benzinga 全期权链数据进行底仓初始化，
 * 以及盘中根据交易流水修正模型持仓增量，避免高频读写冲突。
 */

const { calculateBSGreeks, calculateImpliedVolatility } = require('./bsCalculator');
const { calculateT, calculateDayT, determineTradeDirection } = require('./utils/sharedUtils');
const pricingConfig = require('./pricingConfig');

class PositionStore {
  constructor(config = {}) {
    // 内存持仓字典：{ [ticker]: { [optionSymbol]: optionContractObject } }
    this.store = {};

    this.riskFreeRate = config.riskFreeRate !== undefined ? config.riskFreeRate : pricingConfig.riskFreeRate;
    this.dividendYieldByTicker = config.dividendYieldByTicker || pricingConfig.dividendYieldByTicker;
    this.minRealtimeTMinutes = config.minRealtimeTMinutes !== undefined ? config.minRealtimeTMinutes : pricingConfig.minRealtimeTMinutes;
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
      const expDate = new Date(expirationDateStr + 'T00:00:00Z');
      const curDate = new Date(currentDateStr + 'T00:00:00Z');
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
   * 盘中收到大单交易时，增量更新 flowPositionDelta。
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
      const expDate = new Date(expirationStr + 'T00:00:00Z');
      const curDate = new Date(currentDateStr + 'T00:00:00Z');
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
      const bid = parseFloat(trade.bid);
      const ask = parseFloat(trade.ask);
      const midpoint = parseFloat(trade.midpoint);
      this.store[uppercaseTicker][symbol] = {
        symbol: symbol,
        strike: parseFloat(trade.strike_price),
        type: type,
        expiration: trade.date_expiration,
        bid: Number.isFinite(bid) ? bid : 0,
        ask: Number.isFinite(ask) ? ask : 0,
        midpoint: Number.isFinite(midpoint) ? midpoint : undefined,
        openingOI: oi,
        flowPositionDelta: 0,
        ivRealtime: undefined,
        ivGlobal: undefined
      };
    }

    // 3. 计算本笔交易导致的模型持仓修正量。
    const size = parseInt(trade.size, 10) || 0;
    const direction = this._determineTradeDirection(trade);
    const contract = this.store[uppercaseTicker][symbol];

    if (direction === 'BUY') {
      contract.flowPositionDelta += size;
    } else if (direction === 'SELL') {
      contract.flowPositionDelta -= size;
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
   * @param {number} r - 年化无风险利率
   * @param {string} currentDateStr - 当前计算日期 (YYYY-MM-DD，用于计算剩余期限 T)
   * @param {string} [currentTimeStr="09:30:00"] - 盘中当前时间 (HH:MM:SS)
   * @param {string} [expiryFilter="all"] - 到期日过滤器 (all / 0dte / weekly)
   * @param {object} [greeksConfig] - Clamping 限幅等配置
   * @returns {Array<object>} 计算完 Greeks 和 GEX 后的合约列表
   */
  calculateMatrixGEX(ticker, spot, r, currentDateStr, currentTimeStr = "09:30:00", expiryFilter = "all", greeksConfig = {}) {
    if (!Number.isFinite(spot) || spot <= 0) {
      return [];
    }
    const uppercaseTicker = ticker.toUpperCase();
    const effectiveR = r !== undefined ? r : this.riskFreeRate;
    const q = this._getDividendYield(uppercaseTicker);
    const matrix = this.getPositionMatrix(ticker);

    return matrix.map(contract => {
      // 过滤逻辑
      // Bug #14: 显式指定美东时区防止时区歧义
      const expDate = new Date(contract.expiration + 'T00:00:00Z');
      const curDate = new Date(currentDateStr + 'T00:00:00Z');
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
      const minRealtimeT = this.minRealtimeTMinutes / (365 * 24 * 60);
      const T = Math.max(
        minRealtimeT,
        calculateT(currentDateStr, currentTimeStr, contract.expiration)
      );

      const midpoint = Number(contract.midpoint);
      const bid = Number(contract.bid);
      const ask = Number(contract.ask);
      const quotedMid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
        ? (bid + ask) / 2.0
        : NaN;
      const marketPrice = Number.isFinite(midpoint) && midpoint > 0
        ? midpoint
        : (Number.isFinite(quotedMid) && quotedMid > 0 ? quotedMid : 0.1);

      // 动态反推实时 IV：使用分钟级 T，供实时 GEX 使用
      let ivRealtime = contract.ivRealtime;
      if (ivRealtime === undefined || ivRealtime === null) {
        ivRealtime = calculateImpliedVolatility(spot, contract.strike, T, effectiveR, q, marketPrice, contract.type);
        if (isNaN(ivRealtime) || ivRealtime <= 0.0002) {
          ivRealtime = 0.20; // 实在算不出来的回退默认值为 20%，更贴近真实大盘 (SPY/QQQ) 的底噪 IV
        }
        contract.ivRealtime = ivRealtime;
      }

      // 计算实时 Greeks
      const greeks = calculateBSGreeks(spot, contract.strike, T, effectiveR, q, ivRealtime, contract.type, greeksConfig);

      const openingOI = contract.openingOI || 0;
      const flowPositionDelta = contract.flowPositionDelta || 0;
      const realtimePosition = openingOI + flowPositionDelta;
      const realtimeSignedPosition = this._toSignedPosition(realtimePosition, contract.type);
      const globalSignedPosition = this._toSignedPosition(openingOI, contract.type);

      const realtimeGex = realtimeSignedPosition * greeks.gamma * 100 * (spot * spot) * 0.01;

      // 全局地图 GEX：使用静态 OI（即开盘未平仓量）与天级 T/IV
      const T_global = calculateDayT(currentDateStr, contract.expiration);
      let ivGlobal = contract.ivGlobal;
      if (ivGlobal === undefined || ivGlobal === null) {
        ivGlobal = calculateImpliedVolatility(spot, contract.strike, T_global, effectiveR, q, marketPrice, contract.type);
        if (isNaN(ivGlobal) || ivGlobal <= 0.0002) {
          ivGlobal = 0.20;
        }
        contract.ivGlobal = ivGlobal;
      }
      const greeks_global = calculateBSGreeks(spot, contract.strike, T_global, effectiveR, q, ivGlobal, contract.type, greeksConfig);
      const globalGex = globalSignedPosition * greeks_global.gamma * 100 * (spot * spot) * 0.01;

      return {
        ...contract,
        openingOI,
        dividendYield: q,
        flowPositionDelta,
        realtimePosition,
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
        realtimeGex,
        globalGex
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
    const effectiveR = r !== undefined ? r : this.riskFreeRate;
    const q = this._getDividendYield(uppercaseTicker);
    const matrix = this.getPositionMatrix(uppercaseTicker);
    
    matrix.forEach(contract => {
      // Bug #7: 使用共享工具类计算 T
      const T = calculateT(currentDateStr, currentTimeStr, contract.expiration);
      const marketPrice = contract.midpoint || ((contract.bid + contract.ask) / 2.0) || 0.1;
      let iv = calculateImpliedVolatility(spot, contract.strike, T, effectiveR, q, marketPrice, contract.type);
      if (isNaN(iv) || iv <= 0.0002) {
        iv = 0.20; // 实在算不出的回退默认值为 20%
      }
      contract.ivRealtime = iv;

      const T_global = calculateDayT(currentDateStr, contract.expiration);
      let ivGlobal = calculateImpliedVolatility(spot, contract.strike, T_global, effectiveR, q, marketPrice, contract.type);
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
      openingOI: oi,
      flowPositionDelta: 0,
      bid: bid,
      ask: ask,
      midpoint: midpoint,
      ivRealtime: undefined,
      ivGlobal: undefined
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

  _toSignedPosition(position, optionType) {
    return optionType === 'PUT' ? -position : position;
  }

  _getDividendYield(ticker) {
    return this.dividendYieldByTicker[ticker] || 0;
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
