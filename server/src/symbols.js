// Universe of simulated symbols. Each has a starting price, drift (annualized
// log-return), volatility (annualized stdev), and a base intraday volume rate
// in shares-per-tick. The simulator uses a Geometric Brownian Motion (GBM)
// step per tick to produce realistic-looking intraday movement.
export const SYMBOLS = [
  { symbol: "AAPL", name: "Apple Inc.",            price: 192.45, drift: 0.08, vol: 0.22, vps: 1800 },
  { symbol: "MSFT", name: "Microsoft Corp.",       price: 415.20, drift: 0.10, vol: 0.20, vps: 1200 },
  { symbol: "GOOGL",name: "Alphabet Inc.",         price: 168.30, drift: 0.09, vol: 0.24, vps: 1500 },
  { symbol: "AMZN", name: "Amazon.com Inc.",       price: 182.05, drift: 0.11, vol: 0.28, vps: 1700 },
  { symbol: "NVDA", name: "NVIDIA Corp.",          price: 925.10, drift: 0.20, vol: 0.45, vps: 2400 },
  { symbol: "TSLA", name: "Tesla Inc.",            price: 245.65, drift: 0.05, vol: 0.55, vps: 2200 },
  { symbol: "META", name: "Meta Platforms Inc.",   price: 498.40, drift: 0.12, vol: 0.30, vps: 1100 },
  { symbol: "BTC",  name: "Bitcoin / USD",         price: 67200,  drift: 0.15, vol: 0.65, vps: 30   },
];
