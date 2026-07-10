const axios = require('axios');
const dc = require('./datacenter');
const symbols = require('./tickerConfig');

// for (let symbol of symbols.BUILTIN_TICKERS) {
//   console.log(symbol);
//   let start = Date.now();
//   dc.fetchOptionChain(symbol).then((data) => {
//     console.log(symbol, 'ok', Date.now() - start, 'ms');
//   }).catch((error) => {
//     console.error(`Error fetching option chain for ${symbol}:`, error);
//   });
// }

// axios({
//   url: 'https://query1.finance.yahoo.com/v7/finance/quote?&symbols=AAPL,TSLA,SPY,QQQ,SLV,NVDA,INTC,AMD,MSFT,MU,IWM,GLD,SDNK,NFLX,GOOG&fields=currency,regularMarketChange,regularMarketChangePercent,regularMarketPrice,regularMarketTime,preMarketChange,preMarketChangePercent,preMarketPrice,preMarketTime,priceHint,postMarketChange,postMarketChangePercent,postMarketPrice,postMarketTime,extendedMarketChange,extendedMarketChangePercent,extendedMarketPrice,extendedMarketTime,overnightMarketChange,overnightMarketChangePercent,overnightMarketPrice,overnightMarketTime&crumb=cpQhkVcppc1&formatted=false&region=US&lang=en-US',
//   method: 'GET',
//   headers: {
//     "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
//     "accept-language": "en,zh-CN;q=0.9,zh;q=0.8",
//     // "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
//     "cookie": "A1=d=AQABBA56nmkCEAzP_IYFBGz8vpWdIsEid7cFEgEBCAGbSGp7atwv0iMA_eMDAAcIDnqeacEid7c&S=AQAAAsM1XZCcGVo8TyAN2ucJxGg; A3=d=AQABBA56nmkCEAzP_IYFBGz8vpWdIsEid7cFEgEBCAGbSGp7atwv0iMA_eMDAAcIDnqeacEid7c&S=AQAAAsM1XZCcGVo8TyAN2ucJxGg"
//   }
// }).then((response) => {
//   console.log('Yahoo Finance API response:', JSON.stringify(response.data));
// }).catch((error) => {
//   console.error('Error fetching data from Yahoo Finance API:', error);
// })

// fetch("https://query1.finance.yahoo.com/v7/finance/quote?&symbols=AAPL,TSLA,SPY,QQQ,SLV,NVDA,INTC,AMD,MSFT,MU,IWM,GLD,SDNK,NFLX,GOOG&fields=currency,regularMarketChange,regularMarketChangePercent,regularMarketPrice,regularMarketTime,preMarketChange,preMarketChangePercent,preMarketPrice,preMarketTime,priceHint,postMarketChange,postMarketChangePercent,postMarketPrice,postMarketTime,extendedMarketChange,extendedMarketChangePercent,extendedMarketPrice,extendedMarketTime,overnightMarketChange,overnightMarketChangePercent,overnightMarketPrice,overnightMarketTime&crumb=cpQhkVcppc1&formatted=false&region=US&lang=en-US", {
//   "headers": {
//     "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
//     "accept-language": "en,zh-CN;q=0.9,zh;q=0.8",
//     "cache-control": "max-age=0",
//     "priority": "u=0, i",
//     "sec-ch-ua": "\"Google Chrome\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
//     "sec-ch-ua-mobile": "?0",
//     "sec-ch-ua-platform": "\"Linux\"",
//     "sec-fetch-dest": "document",
//     "sec-fetch-mode": "navigate",
//     "sec-fetch-site": "none",
//     "sec-fetch-user": "?1",
//     "upgrade-insecure-requests": "1",
//     "cookie": "GUC=AQEBCAFqSJtqe0Ii3AUR&s=AQAAAJkloy3S&g=akdW6A; A1=d=AQABBA56nmkCEAzP_IYFBGz8vpWdIsEid7cFEgEBCAGbSGp7atwv0iMA_eMDAAcIDnqeacEid7c&S=AQAAAsM1XZCcGVo8TyAN2ucJxGg; A3=d=AQABBA56nmkCEAzP_IYFBGz8vpWdIsEid7cFEgEBCAGbSGp7atwv0iMA_eMDAAcIDnqeacEid7c&S=AQAAAsM1XZCcGVo8TyAN2ucJxGg; A1S=d=AQABBA56nmkCEAzP_IYFBGz8vpWdIsEid7cFEgEBCAGbSGp7atwv0iMA_eMDAAcIDnqeacEid7c&S=AQAAAsM1XZCcGVo8TyAN2ucJxGg; axids=gam=y-JSH04eRE2uKqOlnCpqwlYVzFIGsRSuxo~A&dv360=eS1lcGRBTjVwRTJ1RktFSWxidEladWw2WTREdXYyTC5BMH5B&ydsp=y-WBC1X5JE2uL_LjAukEKTF7c_A_Km58AU~A&tbla=y-ZqgQPp9E2uJcJ.oCyPlU2yuB4g8fFhZZ~A; tbla_id=1823fcb4-5711-4a5e-ba9a-9aef0771ea82-tuct1068730f; _ga=GA1.1.1258421977.1783060205; _ga_B40QGCQW3G=GS2.1.s1783060204$o1$g0$t1783060350$j44$l0$h0; _ga_WV3PBKGHS2=GS2.1.s1783060207$o1$g0$t1783060350$j44$l0$h0; connectId=%7B%22vmuid%22%3A%228pVf952b8wRqpbMgjl-HilDOFxLhPmt6KS0dyy36JcwhNeV0L03rvr-Zw9dCnzTiIikPSIhnHwzSfRbhSbvQAQ%22%2C%22connectid%22%3A%228pVf952b8wRqpbMgjl-HilDOFxLhPmt6KS0dyy36JcwhNeV0L03rvr-Zw9dCnzTiIikPSIhnHwzSfRbhSbvQAQ%22%2C%22connectId%22%3A%228pVf952b8wRqpbMgjl-HilDOFxLhPmt6KS0dyy36JcwhNeV0L03rvr-Zw9dCnzTiIikPSIhnHwzSfRbhSbvQAQ%22%2C%22ttl%22%3A86400000%2C%22lastSynced%22%3A1783060354980%2C%22lastUsed%22%3A1783060354980%7D; PRF=t%3DAAPL%26o%3D; fes-ds-alphaspace-subs-promotion=1; _ga_YD9K1W9DLN=GS2.1.s1783306498$o3$g0$t1783306498$j60$l0$h0; fes-ds-session=pv%3D6; gpp=DBAA; gpp_sid=-1; cmp=t=1783385397&j=0&u=1---"
//   },
//   "body": null,
//   "method": "GET"
// });


// curl 'https://query1.finance.yahoo.com/v1/finance/screener?formatted=true&useRecordsResponse=true&lang=en-US&region=US&crumb=0xqseBjlxnX' \
// -H 'accept: */*' \
// -H 'accept-language: zh-CN,zh;q=0.9,en;q=0.8' \
// -H 'cache-control: no-cache' \
// -H 'content-type: application/json' \
// -b 'A1=d=AQABBEzMnmkCEAE8RI19qkDbLaSZR0ZhHpgFEgEBCAFZN2piatwv0iMA_eMDAAcITMyeaUZhHpg&S=AQAAAizbrYf8bu0TnBKtHY9glY8; A3=d=AQABBEzMnmkCEAE8RI19qkDbLaSZR0ZhHpgFEgEBCAFZN2piatwv0iMA_eMDAAcITMyeaUZhHpg&S=AQAAAizbrYf8bu0TnBKtHY9glY8' \
// -H 'referer: https://finance.yahoo.com/research-hub/screener/small-cap-stocks?start=0&count=25' \
// -H 'x-crumb: 0xqseBjlxnX' \
// --data - raw '{"size":25,"offset":0,"sortType":"desc","sortField":"intradaymarketcap","includeFields":["ticker","companyshortname","intradayprice","intradaypricechange","percentchange","dayvolume","avgdailyvol3m","intradaymarketcap","peratio.lasttwelvemonths","day_open_price","fiftytwowklow","fiftytwowkhigh","region","exchange","quotesCurrency","financialCurrency"],"topOperator":"AND","query":{"operator":"and","operands":[{"operator":"or","operands":[{"operator":"eq","operands":["region","us"]}]},{"operator":"or","operands":[{"operator":"btwn","operands":["intradaymarketcap",10000,200000000]}]},{"operator":"or","operands":[{"operator":"eq","operands":["exchange","NYQ"]},{"operator":"eq","operands":["exchange","NMS"]},{"operator":"match_any","operands":["exchange","ASE","ASQ"]},{"operator":"eq","operands":["exchange","BTS"]},{"operator":"eq","operands":["exchange","NCM"]},{"operator":"eq","operands":["exchange","NGM"]},{"operator":"eq","operands":["exchange","PCX"]}]}]},"quoteType":"EQUITY"}'

axios({
  url: 'https://query1.finance.yahoo.com/v1/finance/screener?formatted=true&useRecordsResponse=true&lang=en-US&region=US&crumb=0xqseBjlxnX',
  method: 'POST',
  headers: {
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "referer": "https://finance.yahoo.com/research-hub/screener/small-cap-stocks?start=0&count=25",
    "x-crumb": "0xqseBjlxnX",
    "cookie": "A1=d=AQABBEzMnmkCEAE8RI19qkDbLaSZR0ZhHpgFEgEBCAFZN2piatwv0iMA_eMDAAcITMyeaUZhHpg&S=AQAAAizbrYf8bu0TnBKtHY9glY8; A3=d=AQABBEzMnmkCEAE8RI19qkDbLaSZR0ZhHpgFEgEBCAFZN2piatwv0iMA_eMDAAcITMyeaUZhHpg&S=AQAAAizbrYf8bu0TnBKtHY9glY8"
  },
  data: {
    "size": 100,
    "offset": 0,
    "sortType": "desc",
    "sortField": "intradaymarketcap",
    "includeFields": [
      "ticker",
      "companyshortname",
      "intradayprice",
      "intradaypricechange",
      "percentchange",
      "dayvolume",
      "avgdailyvol3m",
      "intradaymarketcap",
      "peratio.lasttwelvemonths",
      "day_open_price",
      "fiftytwowklow",
      "fiftytwowkhigh",
      "region",
      "exchange",
      "quotesCurrency",
      "financialCurrency"
    ],
    "topOperator": "AND",
    "query": {
      "operator": "and",
      "operands": [
        {
          "operator": "or",
          "operands": [
            {
              "operator": "eq",
              "operands": [
                "region",
                "us"
              ]
            }
          ]
        },
        {
          "operator": "or",
          "operands": [
            {
              "operator": "btwn",
              "operands": [
                "intradaymarketcap",
                10000,
                200000000
              ]
            }
          ]
        },
        {
          "operator": "or",
          "operands": [
            {
              "operator": "eq",
              "operands": [
                "exchange",
                "NYQ"
              ]
            },
            {
              "operator": "eq",
              "operands": [
                "exchange",
                "NMS"
              ]
            },
            {
              "operator": "match_any",
              "operands": [
                "exchange",
                "ASE",
                "ASQ"
              ]
            },
            {
              "operator": "eq",
              "operands": [
                "exchange",
                "BTS"
              ]
            },
            {
              "operator": "eq",
              "operands": [
                "exchange",
                "NCM"
              ]
            },
            {
              "operator": "eq",
              "operands": [
                "exchange",
                "NGM"
              ]
            },
            {
              "operator": "eq",
              "operands": [
                "exchange",
                "PCX"
              ]
            }
          ]
        }
      ]
    },
    "quoteType": "EQUITY"
  }
}).then((response) => {
  console.log('Yahoo Finance Screener API response:', JSON.stringify(response.data));
}).catch((error) => {
  console.error('Error fetching data from Yahoo Finance Screener API:', error);
});