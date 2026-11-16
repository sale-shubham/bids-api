// Full demo data set: ~30 members, ~36 auctions in every state, bids, sales, deposits, strikes, reports, invoices...
// Everything hangs off demo members (email ends with @demo.noblebid.test) or their auctions, so
// `npm run seed:demo:clean` can remove it. Re-runnable: it cleans the old demo data first, in the same transaction.
// Run manually: npm run seed:demo   (uses DIRECT_URL, falls back to DATABASE_URL)
// Never touches AppSetting, Category, the Super Admin or any non-demo row. Needs `npm run prisma:seed` first.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { cleanDemo, createPrisma, DEMO_DOMAIN, type Tx } from './demo-shared';
import { resolveMaxBid } from '../src/modules/auctions/bidding.rules';
import { computeInvoiceTax, financialYearOf, invoiceNumber } from '../src/modules/invoices/invoice.rules';
import { strikeExpiry } from '../src/modules/strikes/strikes.rules';
import { scoreOf, type RiskReason } from '../src/modules/risk/risk.rules';

export const DEMO_PASSWORD = 'Demo@12345'; // letter + number, 8+ chars: passes the signup password rule
const prisma = createPrisma();

// ------------------------------------------------------------------ helpers
const H = 3_600_000;
const D = 24 * H;
const NOW = Date.now();
const R = (rupees: number) => Math.round(rupees * 100); // rupees -> paise
const big = (n: number) => BigInt(n);
const at = (offsetMs: number) => new Date(NOW + offsetMs);
const uid = () => crypto.randomUUID();
const inr = (paise: number) => `Rs ${(paise / 100).toLocaleString('en-IN')}`;
let seedState = 20261116;
const rnd = () => {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
};
const rint = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pad2 = (n: number) => String(n).padStart(2, '0');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const refCode = (key: string) => {
  const h = crypto.createHash('sha1').update(`demo-ref-${key}`).digest();
  return Array.from({ length: 8 }, (_, i) => B32[h[i] % 32]).join('');
};
/** Asia/Kolkata calendar date of an instant, as a UTC-midnight Date (what a @db.Date column stores). */
const istDate = (ms: number) => {
  const d = new Date(ms + 330 * 60_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

// ------------------------------------------------------------------ members
type Cond = 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR' | 'USED' | 'FOR_PARTS';
const BIDDERS: [string, string, string, string?][] = [
  ['Aarav Sharma', 'Mumbai', '27'],
  ['Priya Nair', 'Kochi', '32'],
  ['Rohan Mehta', 'Ahmedabad', '24'],
  ['Ananya Iyer', 'Chennai', '33'],
  ['Vikram Singh', 'Jaipur', '08'],
  ['Sneha Reddy', 'Hyderabad', '36'],
  ['Arjun Patel', 'Surat', '24'],
  ['Kavya Menon', 'Bengaluru', '29'],
  ['Rahul Verma', 'Lucknow', '09'],
  ['Isha Gupta', 'Delhi', '07'],
  ['Siddharth Rao', 'Mysuru', '29'],
  ['Meera Joshi', 'Pune', '27'],
  ['Karan Malhotra', 'Chandigarh', '04'],
  ['Divya Pillai', 'Thiruvananthapuram', '32'],
  ['Aditya Kulkarni', 'Nagpur', '27'],
  ['Pooja Bansal', 'Indore', '23'],
  ['Nikhil Desai', 'Vadodara', '24'],
  ['Ritu Agarwal', 'Kolkata', '19'],
  ['Manish Yadav', 'Patna', '10'],
  ['Tanvi Bhatt', 'Bhopal', '23'],
  ['Harsh Vardhan', 'Dehradun', '05'],
];
const SELLERS: [string, string, string, string | null][] = [
  ['Rajesh Kumar Antiques', 'Delhi', '07', '07ABCDE1234F1Z5'],
  ['Lakshmi Textiles', 'Varanasi', '09', null],
  ['Gurpreet Singh Collectibles', 'Amritsar', '03', null],
  ['Suresh Motors and Sports', 'Pune', '27', '27PQRSX5678L1Z2'],
  ['Anita Crafts', 'Jaipur', '08', null],
  ['Mohan Electronics', 'Bengaluru', '29', '29LMNOP4321Q1Z9'],
  ['Deepak Vintage House', 'Kolkata', '19', null],
  ['Farhan Traders', 'Hyderabad', '36', null],
  ['Neha Bazaar', 'Mumbai', '27', null],
];
const bk = (i: number) => `b${pad2(i)}`;
const sk = (i: number) => `s${pad2(i)}`;
const SUSPENDED = new Set(['b20', 's09']);
const VERIFIED = new Set(['s01', 's02', 's03', 's04']);
const memberKeys = [...BIDDERS.map((_, i) => bk(i + 1)), ...SELLERS.map((_, i) => sk(i + 1))];
const mid: Record<string, string> = Object.fromEntries(memberKeys.map((k) => [k, uid()]));
const memberName: Record<string, string> = {};
BIDDERS.forEach((b, i) => (memberName[bk(i + 1)] = b[0]));
SELLERS.forEach((s, i) => (memberName[sk(i + 1)] = s[0]));
const emailOf = (k: string) => `${k[0] === 'b' ? 'bidder' : 'seller'}${k.slice(1)}${DEMO_DOMAIN}`;

// ------------------------------------------------------------------ auction plan
const SHIP = {
  both: { pickup: true, pickupCity: 'Mumbai', courier: true, shippingFeePaise: R(150), shipsWithinDays: 3 },
  courier: { pickup: false, courier: true, shippingFeePaise: R(250), shipsWithinDays: 5 },
  pickup: { pickup: true, pickupCity: 'Pune', courier: false },
  free: { pickup: false, courier: true, shippingFeePaise: 0, shipsWithinDays: 2 },
} as const;
type Ship = keyof typeof SHIP;
type SaleSt = 'AWAITING_PAYMENT' | 'PAID' | 'SHIPPED' | 'DELIVERED' | 'RELEASED' | 'DISPUTED' | 'REFUNDED';
type Outcome =
  | { t: 'sale'; st: SaleSt; review?: { rating: number; comment: string; reply?: string; hidden?: boolean } }
  | { t: 'cancelled'; offer: 'PENDING' | 'ACCEPTED_AWAIT' | 'ACCEPTED_PAID' | 'DECLINED' | 'EXPIRED' | null; removed?: boolean }
  | { t: 'comm'; st: 'DUE' | 'OVERDUE' | 'PAID' | 'WAIVED' };
type Spec = {
  k: string;
  title: string;
  seller: string;
  cat: string;
  cond: Cond;
  start: number; // rupees
  inc?: number; // rupees
  reserve?: number;
  buyNow?: number;
  deposit?: number;
  est?: [number, number];
  status: 'LIVE' | 'SCHEDULED' | 'ENDED' | 'CANCELLED';
  s: number; // start, hours from now
  e: number; // end, hours from now
  bids?: [string, number][]; // [bidder, max in rupees], placed in order
  buyNowBy?: string;
  ship: Ship;
  feat?: number; // featured days
  report?: string;
  out?: Outcome;
  blurb?: string;
};

const SP: Spec[] = [
  // ---- LIVE
  { k: 'L1', title: 'Vintage Yashica Electro 35 film camera', seller: 's01', cat: 'Electronics', cond: 'GOOD', start: 4500, reserve: 8000, est: [8000, 12000], status: 'LIVE', s: -16 * 24, e: 3 * 24, bids: [['b01', 5000], ['b02', 6500], ['b03', 9000], ['b01', 9500]], ship: 'both', report: 'Rangefinder works, light seals replaced, lens clean with minor dust. Comes with leather case.' },
  { k: 'L2', title: 'Sony noise-cancelling wireless headphones', seller: 's01', cat: 'Electronics', cond: 'NEW', start: 6500, buyNow: 12000, status: 'LIVE', s: -24, e: 2 * 24, ship: 'free' },
  { k: 'L3', title: 'Banarasi silk saree, bridal red with zari border', seller: 's02', cat: 'Fashion', cond: 'NEW', start: 12000, reserve: 20000, est: [22000, 30000], status: 'LIVE', s: -15 * 24, e: 0.66, bids: [['b04', 12000], ['b05', 13000], ['b04', 15000], ['b06', 16000]], ship: 'courier', feat: 3 },
  { k: 'L4', title: 'Teak wood garden bench, four seater', seller: 's02', cat: 'Home & Garden', cond: 'USED', start: 8000, status: 'LIVE', s: -15 * 24, e: 0.4, bids: [['b07', 8000], ['b08', 9500]], ship: 'pickup' },
  { k: 'L5', title: 'Signed cricket bat, 1983 World Cup squad', seller: 's03', cat: 'Collectibles', cond: 'GOOD', start: 25000, reserve: 40000, deposit: 2500, est: [40000, 60000], status: 'LIVE', s: -15 * 24, e: 5, bids: [['b09', 26000], ['b10', 35000], ['b09', 42000], ['b11', 43000]], ship: 'courier', feat: 7, report: 'Authenticity certificate included. Minor edge wear on the blade.' },
  { k: 'L6', title: 'Original oil painting, river at dusk', seller: 's03', cat: 'Art', cond: 'NEW', start: 18000, buyNow: 45000, status: 'LIVE', s: -48, e: 24, bids: [['b12', 18000], ['b13', 20000]], ship: 'both' },
  { k: 'L7', title: '2018 Royal Enfield Classic 350, 25,000 km', seller: 's04', cat: 'Vehicles', cond: 'USED', start: 120000, inc: 1000, reserve: 150000, deposit: 12000, est: [160000, 190000], status: 'LIVE', s: -16 * 24, e: 2 * 24, bids: [['b14', 125000], ['b15', 140000], ['b14', 152000]], ship: 'pickup', feat: 7, report: 'Single owner, all service records available. New tyres fitted last month, small scratch on the tank.' },
  { k: 'L8', title: 'Gaming laptop, RTX 3060, 16GB RAM', seller: 's06', cat: 'Electronics', cond: 'USED', start: 45000, inc: 500, reserve: 55000, deposit: 4500, est: [58000, 70000], status: 'LIVE', s: -5 * 24, e: 24, bids: [['b17', 46000], ['b18', 60000], ['b17', 58000]], ship: 'both', feat: 3, report: 'Battery health 86 percent. Original charger and box included.' },
  // ---- SCHEDULED
  { k: 'S1', title: 'Restored 1980s Lambretta scooter', seller: 's07', cat: 'Vehicles', cond: 'FAIR', start: 60000, inc: 1000, reserve: 80000, deposit: 6000, est: [90000, 120000], status: 'SCHEDULED', s: 6, e: 4 * 24, ship: 'pickup', feat: 3, report: 'Engine rebuilt, repainted. Papers clear.' },
  { k: 'S2', title: 'Brass Nataraja statue, 18 inch', seller: 's07', cat: 'Collectibles', cond: 'GOOD', start: 22000, buyNow: 40000, est: [30000, 45000], status: 'SCHEDULED', s: 24, e: 6 * 24, ship: 'courier' },
  { k: 'S3', title: 'Vintage Parker fountain pen collection (5 pens)', seller: 's01', cat: 'Other', cond: 'LIKE_NEW', start: 3500, status: 'SCHEDULED', s: 12, e: 3 * 24, ship: 'both', feat: 3 },
  // ---- ENDED, reserve not met / no bids
  { k: 'R1', title: 'Handloom Kanjeevaram stole set', seller: 's02', cat: 'Fashion', cond: 'NEW', start: 8000, reserve: 15000, status: 'ENDED', s: -9 * 24, e: -48, bids: [['b19', 8000], ['b05', 10000]], ship: 'courier' },
  { k: 'R2', title: 'Cast-iron cookware set, pre-seasoned', seller: 's05', cat: 'Home & Garden', cond: 'LIKE_NEW', start: 4000, reserve: 7000, status: 'ENDED', s: -8 * 24, e: -96, bids: [['b06', 4500]], ship: 'both' },
  { k: 'N1', title: 'Vintage brass table lamp, antique finish', seller: 's06', cat: 'Home & Garden', cond: 'USED', start: 2000, status: 'ENDED', s: -9 * 24, e: -72, ship: 'courier' },
  // ---- CANCELLED
  { k: 'C1', title: 'Antique wooden almirah, Burma teak', seller: 's01', cat: 'Home & Garden', cond: 'USED', start: 15000, status: 'CANCELLED', s: -24, e: 5 * 24, ship: 'pickup' },
  { k: 'C2', title: 'Motorised treadmill, home use', seller: 's09', cat: 'Sports', cond: 'USED', start: 12000, status: 'CANCELLED', s: -2 * 24, e: 4 * 24, ship: 'pickup' },
  // ---- SOLD through checkout (Sale), one per sale status
  { k: 'Q1', title: 'Gaming headset, barely used', seller: 's01', cat: 'Electronics', cond: 'LIKE_NEW', start: 3000, status: 'ENDED', s: -8 * 24, e: -24, bids: [['b01', 3000], ['b02', 3600], ['b01', 4300]], ship: 'both', out: { t: 'sale', st: 'AWAITING_PAYMENT' } },
  { k: 'Q2', title: 'Pashmina shawl, hand embroidered', seller: 's02', cat: 'Fashion', cond: 'NEW', start: 9000, buyNow: 20000, status: 'ENDED', s: -4 * 24, e: -72, buyNowBy: 'b03', ship: 'courier', out: { t: 'sale', st: 'PAID' } },
  { k: 'Q3', title: 'Bronze Ganesha idol, 12 inch', seller: 's03', cat: 'Collectibles', cond: 'GOOD', start: 12000, reserve: 14000, status: 'ENDED', s: -9 * 24, e: -5 * 24, bids: [['b05', 12000], ['b07', 14500], ['b05', 16500]], ship: 'both', feat: 1, out: { t: 'sale', st: 'SHIPPED' } },
  { k: 'Q4', title: 'Yamaha F310 acoustic guitar', seller: 's04', cat: 'Sports', cond: 'GOOD', start: 7000, deposit: 700, status: 'ENDED', s: -12 * 24, e: -8 * 24, bids: [['b07', 7000], ['b09', 8200]], ship: 'both', feat: 3, out: { t: 'sale', st: 'DELIVERED', review: { rating: 5, comment: 'Exactly as described and packed very well. Smooth deal.', reply: 'Thank you Arjun, enjoy the guitar!' } } },
  { k: 'Q5', title: 'Mini tablet, 64GB, with cover', seller: 's01', cat: 'Electronics', cond: 'GOOD', start: 6000, status: 'ENDED', s: -13 * 24, e: -9 * 24, bids: [['b10', 6000], ['b04', 7200]], ship: 'courier', out: { t: 'sale', st: 'DELIVERED', review: { rating: 1, comment: 'Rude reply on chat, review hidden by moderators after a report.', hidden: true } } },
  { k: 'Q6', title: 'Terracotta planter set of six', seller: 's05', cat: 'Home & Garden', cond: 'NEW', start: 2500, deposit: 250, status: 'ENDED', s: -18 * 24, e: -14 * 24, bids: [['b09', 2500], ['b12', 3300], ['b09', 4000]], ship: 'both', out: { t: 'sale', st: 'RELEASED', review: { rating: 5, comment: 'Beautiful pots, no breakage at all.', reply: 'Glad you liked them. Thanks for shopping!' } } },
  { k: 'Q7', title: 'Diamond-cut silver bracelet', seller: 's06', cat: 'Jewellery', cond: 'NEW', start: 5000, deposit: 500, status: 'ENDED', s: -19 * 24, e: -15 * 24, bids: [['b13', 5000], ['b02', 6200]], ship: 'courier', out: { t: 'sale', st: 'RELEASED', review: { rating: 4, comment: 'Good quality, delivery took a day longer than promised.' } } },
  { k: 'Q8', title: 'Wireless earbuds, factory sealed', seller: 's06', cat: 'Electronics', cond: 'NEW', start: 2500, status: 'ENDED', s: -10 * 24, e: -6 * 24, bids: [['b14', 2500], ['b16', 3100]], ship: 'courier', out: { t: 'sale', st: 'DISPUTED' } },
  { k: 'Q9', title: 'Hardcover Ruskin Bond collection (10 books)', seller: 's05', cat: 'Books', cond: 'GOOD', start: 3000, status: 'ENDED', s: -14 * 24, e: -10 * 24, bids: [['b08', 3000], ['b15', 3800]], ship: 'both', out: { t: 'sale', st: 'REFUNDED' } },
  // ---- SOLD but the winner never paid: sale CANCELLED + strike (+ second-chance offer)
  { k: 'X1', title: 'Silk blend kurta set, festive wear', seller: 's02', cat: 'Fashion', cond: 'NEW', start: 3000, status: 'ENDED', s: -8 * 24, e: -(3 * 24 + 10), bids: [['b03', 3000], ['b19', 4200]], ship: 'courier', out: { t: 'cancelled', offer: 'PENDING' } },
  { k: 'X2', title: 'Vintage Bluetooth speaker, wooden finish', seller: 's01', cat: 'Electronics', cond: 'GOOD', start: 2500, status: 'ENDED', s: -13 * 24, e: -9 * 24, bids: [['b05', 2500], ['b18', 3400]], ship: 'both', out: { t: 'cancelled', offer: 'ACCEPTED_AWAIT' } },
  { k: 'X3', title: 'Hand-carved wooden chess set', seller: 's03', cat: 'Collectibles', cond: 'LIKE_NEW', start: 4000, status: 'ENDED', s: -14 * 24, e: -10 * 24, bids: [['b06', 4000], ['b18', 5500]], ship: 'courier', out: { t: 'cancelled', offer: 'ACCEPTED_PAID' } },
  { k: 'X4', title: 'Yoga mat and block combo', seller: 's04', cat: 'Sports', cond: 'NEW', start: 1500, deposit: 150, status: 'ENDED', s: -20 * 24, e: -16 * 24, bids: [['b04', 1500], ['b20', 2200]], ship: 'courier', out: { t: 'cancelled', offer: 'DECLINED' } },
  { k: 'X5', title: 'Kundan jhumka earrings', seller: 's06', cat: 'Jewellery', cond: 'NEW', start: 6000, deposit: 600, status: 'ENDED', s: -22 * 24, e: -18 * 24, bids: [['b10', 6000], ['b20', 7600]], ship: 'courier', out: { t: 'cancelled', offer: 'EXPIRED' } },
  { k: 'X6', title: 'Eight-year-old bonsai ficus', seller: 's05', cat: 'Home & Garden', cond: 'GOOD', start: 3500, deposit: 350, status: 'ENDED', s: -24 * 24, e: -20 * 24, bids: [['b11', 3500], ['b20', 4900]], ship: 'pickup', out: { t: 'cancelled', offer: 'EXPIRED' } },
  { k: 'X7', title: 'Set of five classic Hindi novels', seller: 's02', cat: 'Books', cond: 'GOOD', start: 1200, status: 'ENDED', s: -26 * 24, e: -22 * 24, bids: [['b17', 1200]], ship: 'both', out: { t: 'cancelled', offer: null, removed: true } },
  // ---- SOLD with a commission (seller has no active payout account)
  { k: 'K1', title: 'Electric pottery wheel with tools', seller: 's07', cat: 'Other', cond: 'GOOD', start: 9000, status: 'ENDED', s: -6 * 24, e: -48, bids: [['b01', 9000], ['b12', 10500]], ship: 'pickup', out: { t: 'comm', st: 'DUE' } },
  { k: 'K2', title: 'Student-grade sitar with hard case', seller: 's07', cat: 'Other', cond: 'USED', start: 7000, status: 'ENDED', s: -16 * 24, e: -12 * 24, bids: [['b14', 7000], ['b21', 8800]], ship: 'courier', out: { t: 'comm', st: 'OVERDUE' } },
  { k: 'K3', title: 'Polaroid instant camera, boxed', seller: 's08', cat: 'Electronics', cond: 'LIKE_NEW', start: 5000, buyNow: 9000, status: 'ENDED', s: -12 * 24, e: -9 * 24, buyNowBy: 'b16', ship: 'both', out: { t: 'comm', st: 'PAID' } },
  { k: 'K4', title: 'Antique brass pooja lamp set', seller: 's08', cat: 'Other', cond: 'USED', start: 4000, status: 'ENDED', s: -10 * 24, e: -6 * 24, bids: [['b21', 4000], ['b09', 5200]], ship: 'both', out: { t: 'comm', st: 'WAIVED' } },
];

// ------------------------------------------------------------------ simulate bidding with the app's own proxy rules
type SimRow = { bidder: string; amount: number; kind: 'MANUAL' | 'AUTO' | 'BUY_NOW'; at: number };
type Sim = { rows: SimRow[]; price: number; leader: string | null; bidCount: number; maxes: Map<string, number>; placements: { bidder: string; at: number; tookLeadFrom: string | null }[] };

function simulate(a: Spec, startMs: number, endMs: number): Sim {
  const maxes = new Map<string, number>();
  const rows: SimRow[] = [];
  const placements: Sim['placements'] = [];
  if (a.buyNowBy) {
    const price = R(a.buyNow!);
    maxes.set(a.buyNowBy, price);
    rows.push({ bidder: a.buyNowBy, amount: price, kind: 'BUY_NOW', at: endMs });
    return { rows, price, leader: a.buyNowBy, bidCount: 1, maxes, placements: [{ bidder: a.buyNowBy, at: endMs, tookLeadFrom: null }] };
  }
  const inc = R(a.inc ?? 100);
  const st = { bidCount: 0, startingBidPaise: R(a.start), currentBidPaise: 0, highestBidderId: null as string | null, reservePricePaise: a.reserve ? R(a.reserve) : null };
  const script = a.bids ?? [];
  const span = Math.min(NOW, endMs) - startMs;
  script.forEach(([bidder, rupees], i) => {
    const t = startMs + Math.floor((span * (i + 1)) / (script.length + 1));
    const prev = st.highestBidderId;
    let res;
    try {
      res = resolveMaxBid({
        auction: st,
        minIncrementPaise: inc,
        leaderMaxPaise: prev ? (maxes.get(prev) ?? null) : null,
        bidderId: bidder,
        maxPaise: R(rupees),
      });
    } catch (err) {
      throw new Error(`Bad bid script for ${a.k}: ${bidder} ${rupees} (${(err as Error).message})`);
    }
    maxes.set(bidder, R(rupees));
    res.rows.forEach((r, j) => rows.push({ bidder: r.bidderId, amount: r.amountPaise, kind: r.kind, at: t + j * 1500 }));
    st.bidCount += res.rows.length;
    st.currentBidPaise = res.currentBidPaise;
    st.highestBidderId = res.highestBidderId;
    placements.push({ bidder, at: t, tookLeadFrom: prev && prev !== res.highestBidderId ? prev : null });
  });
  return { rows, price: st.currentBidPaise, leader: st.highestBidderId, bidCount: st.bidCount, maxes, placements };
}

// ------------------------------------------------------------------ main
type Notif = { type: string; memberKey: string; title: string; body: string; url: string; data?: object; at: number };

async function main() {
  const [roots, settingsRows, admin] = await Promise.all([
    prisma.category.findMany({ where: { parentId: null, isActive: true }, select: { id: true, name: true, attributeSchema: true } }),
    prisma.appSetting.findMany({ where: { key: { in: ['commission.rateBps', 'invoice.gstin', 'invoice.stateCode', 'invoice.gstRateBps'] } } }),
    prisma.member.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { id: true } }),
  ]);
  if (roots.length === 0) throw new Error('No categories: run `npm run prisma:seed` first');
  const catByName = new Map(roots.map((c) => [c.name, c]));
  const setting = (k: string) => settingsRows.find((r) => r.key === k)?.value ?? '';
  const rateBps = Number.parseInt(setting('commission.rateBps'), 10) || 500;
  const platform = {
    gstin: setting('invoice.gstin') || null,
    stateCode: setting('invoice.stateCode') || '27',
    gstRateBps: Number.parseInt(setting('invoice.gstRateBps'), 10) || 1800,
  };
  const adminId = admin?.id ?? null;
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12); // same cost as the auth code (BCRYPT_COST)

  // ---- accumulators
  const counters = new Map<string, { auctionsWon: number; moneySpent: number; unpaid: number; ratingCount: number; ratingSum: number; followers: number }>();
  const ctr = (k: string) => {
    if (!counters.has(k)) counters.set(k, { auctionsWon: 0, moneySpent: 0, unpaid: 0, ratingCount: 0, ratingSum: 0, followers: 0 });
    return counters.get(k)!;
  };
  const notifs: Notif[] = [];
  const note = (type: string, memberKey: string, title: string, body: string, url: string, atMs: number, data?: object) =>
    notifs.push({ type, memberKey, title, body, url, at: Math.min(atMs, NOW - 60_000), data });

  const auctions: Record<string, unknown>[] = [];
  const bids: Record<string, unknown>[] = [];
  const maxBidRows: Record<string, unknown>[] = [];
  const orders: Record<string, unknown>[] = [];
  const sales: Record<string, unknown>[] = [];
  const commissions: Record<string, unknown>[] = [];
  const strikes: Record<string, unknown>[] = [];
  const offers: Record<string, unknown>[] = [];
  const deposits: Record<string, unknown>[] = [];
  const reviews: Record<string, unknown>[] = [];
  const features: Record<string, unknown>[] = [];
  const credits: Record<string, unknown>[] = [];
  const invoiceReqs: { type: 'COMMISSION' | 'FEATURE' | 'DEPOSIT_FORFEIT'; refId: string; memberKey: string; total: number; issuedAt: number }[] = [];
  const aid: Record<string, string> = {};
  const aTitle: Record<string, string> = {};
  const aSeller: Record<string, string> = {};
  const aSim: Record<string, Sim> = {};
  const aWinner: Record<string, string | null> = {};
  const aSale: Record<string, string> = {}; // auction key -> first (original) sale id
  const reviewIdByAuction: Record<string, string> = {};
  const saleInfo: Record<string, { buyer: string; seller: string; status: string; paidAt: number | null }> = {};

  const order = (memberKey: string, amount: number, refType: string, refId: string, status: 'CREATED' | 'PAID' | 'FAILED', createdAt: number) => {
    const id = uid();
    orders.push({
      id,
      memberId: mid[memberKey],
      gatewayOrderId: `order_demo_${id.slice(0, 14)}`,
      amountPaise: big(amount),
      status,
      referenceType: refType,
      referenceId: refId,
      gatewayPaymentId: status === 'PAID' ? `pay_demo_${id.slice(0, 14)}` : null,
      idempotencyKey: `demo:${refType.toLowerCase()}:${refId}`,
      createdAt: new Date(createdAt),
    });
    return { id, payId: status === 'PAID' ? `pay_demo_${id.slice(0, 14)}` : null };
  };

  // ============================================================ auctions, bids, sales, commissions
  for (const [n, a] of SP.entries()) {
    const id = uid();
    aid[a.k] = id;
    aTitle[a.k] = a.title;
    aSeller[a.k] = a.seller;
    const startMs = NOW + a.s * H;
    const endMs = NOW + a.e * H;
    const cat = catByName.get(a.cat);
    if (!cat) throw new Error(`Category "${a.cat}" is missing`);
    const sim = a.status === 'LIVE' || a.status === 'ENDED' ? simulate(a, startMs, endMs) : ({ rows: [], price: 0, leader: null, bidCount: 0, maxes: new Map(), placements: [] } as Sim);
    aSim[a.k] = sim;
    const reserveP = a.reserve ? R(a.reserve) : null;
    const ended = a.status === 'ENDED';
    const sold = ended && sim.bidCount > 0 && (reserveP === null || sim.price >= reserveP);
    const winner = sold ? sim.leader : null;
    aWinner[a.k] = winner;

    // Category attributes: the seeded categories have empty schemas, so this is only filled when an admin adds some.
    const schema = Array.isArray(cat.attributeSchema) ? (cat.attributeSchema as { key: string; type: string; options?: string[]; required?: boolean }[]) : [];
    const attrs: Record<string, string | number> = {};
    for (const def of schema) {
      if (def.type === 'select' && def.options?.length) attrs[def.key] = def.options[n % def.options.length];
      else if (def.type === 'number') attrs[def.key] = 10 + n;
      else if (def.type === 'text') attrs[def.key] = def.required ? `Demo ${a.cat} item` : `Demo ${def.key}`;
    }

    const featuredUntil = a.feat ? new Date(Math.min(endMs, a.status === 'ENDED' ? endMs : NOW + a.feat * D)) : null;
    auctions.push({
      id,
      title: a.title,
      description: `<p>${a.title}. Demo listing for NobleBid testing.</p><p>${a.blurb ?? 'Genuine item, accurately described. Ask a question below before you bid.'}</p><p>Pickup or tracked shipping as per the options on this listing.</p>`,
      category: cat.name,
      categoryId: cat.id,
      attributes: Object.keys(attrs).length ? attrs : undefined,
      condition: a.cond,
      conditionReport: a.report ? `<p>${a.report}</p>` : null,
      estimateLowPaise: a.est ? big(R(a.est[0])) : null,
      estimateHighPaise: a.est ? big(R(a.est[1])) : null,
      images: Array.from({ length: 2 + (n % 3) }, (_, k) => `https://picsum.photos/seed/noblebid-demo-${n + 1}-${k + 1}/800/600`),
      shippingOptions: SHIP[a.ship],
      startingBidPaise: big(R(a.start)),
      minIncrementPaise: big(R(a.inc ?? 100)),
      currentBidPaise: big(sim.price),
      reservePricePaise: reserveP ? big(reserveP) : null,
      buyNowPricePaise: a.buyNow ? big(R(a.buyNow)) : null,
      depositPaise: a.deposit ? big(R(a.deposit)) : null,
      bidCount: sim.bidCount,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      status: a.status,
      sellerId: mid[a.seller],
      highestBidderId: sim.leader ? mid[sim.leader] : null,
      winnerId: winner ? mid[winner] : null,
      endedAt: ended ? new Date(endMs) : null,
      featuredUntil,
      createdAt: new Date(Math.min(startMs, NOW) - 2 * H),
    });
    for (const r of sim.rows) bids.push({ id: uid(), auctionId: id, bidderId: mid[r.bidder], amountPaise: big(r.amount), kind: r.kind, createdAt: new Date(r.at) });
    for (const [bidder, max] of sim.maxes) maxBidRows.push({ auctionId: id, bidderId: mid[bidder], maxAmountPaise: big(max), createdAt: new Date(startMs), updatedAt: new Date(endMs < NOW ? endMs : NOW) });

    // outbid alerts (first few per auction) and "you won"
    sim.placements.filter((p) => p.tookLeadFrom).slice(0, 2).forEach((p, i) =>
      note('outbid', p.tookLeadFrom!, 'You have been outbid', `Someone bid ${inr(sim.price)} on "${a.title}". Place a higher bid to stay in the lead.`, `/auctions/${id}`, p.at + 1000 + i, { newBidPaise: sim.price }),
    );

    if (a.status === 'CANCELLED') continue;
    if (ended && !sold && sim.bidCount === 0) note('auction-unsold', a.seller, 'Your auction ended without bids', `"${a.title}" ended with no bids. You can republish it.`, `/auctions/${id}`, endMs + 60_000);
    if (ended && sim.bidCount > 0 && !sold) {
      note('auction-unsold', a.seller, 'Your auction ended below your reserve', `"${a.title}" received bids but none reached your reserve price, so it did not sell.`, `/auctions/${id}`, endMs + 60_000, { reserveNotMet: true });
      note('reserve-not-met', sim.leader!, 'Reserve price not met', `You had the highest bid on "${a.title}", but it did not reach the seller's reserve price.`, `/auctions/${id}`, endMs + 60_000);
    }
    if (!sold || !winner || !a.out) continue;

    const price = sim.price;
    const commissionPaise = Math.round((price * rateBps) / 10_000);
    const w = ctr(winner);
    w.auctionsWon += 1;
    w.moneySpent += price;
    note('auction-won', winner, 'You won the auction', `You won "${a.title}" with a bid of ${inr(price)}.`, `/auctions/${id}`, endMs + 30_000, { finalBidPaise: price });
    note('auction-sold', a.seller, 'Your auction sold', `"${a.title}" sold for ${inr(price)}.`, `/auctions/${id}`, endMs + 30_000, { finalBidPaise: price, commissionPaise });

    const out = a.out;
    if (out.t === 'comm') {
      const dueAt = out.st === 'OVERDUE' ? endMs + 7 * D : endMs + 7 * D; // OVERDUE auctions ended 12 days ago, so dueAt is past
      const status = out.st === 'PAID' ? 'PAID' : out.st === 'WAIVED' ? 'WAIVED' : 'DUE';
      const cid = uid();
      let paymentOrderId: string | null = null;
      let paidAt: Date | null = null;
      if (status === 'PAID') {
        const po = order(a.seller, commissionPaise, 'COMMISSION', cid, 'PAID', endMs + 2 * D);
        paymentOrderId = po.id;
        paidAt = new Date(endMs + 2 * D);
        invoiceReqs.push({ type: 'COMMISSION', refId: cid, memberKey: a.seller, total: commissionPaise, issuedAt: endMs + 2 * D });
        note('commission-paid', a.seller, 'Commission paid', `Thanks, your commission of ${inr(commissionPaise)} for "${a.title}" is paid.`, '/sell/commissions', endMs + 2 * D);
      } else {
        note('commission-due', a.seller, 'Commission due', `Commission of ${inr(commissionPaise)} for "${a.title}" is due.`, '/sell/commissions', endMs + H, { commissionPaise, dueAt: new Date(dueAt).toISOString() });
      }
      if (status === 'DUE') ctr(a.seller).unpaid += commissionPaise;
      commissions.push({ id: cid, auctionId: id, sellerId: mid[a.seller], rateBps, amountPaise: big(commissionPaise), status, dueAt: new Date(dueAt), paidAt, paymentOrderId, createdAt: new Date(endMs) });
      continue;
    }

    // ---- Sale (checkout)
    const ship = SHIP[a.ship] as { courier: boolean; shippingFeePaise?: number };
    const choice: 'COURIER' | 'PICKUP' = ship.courier ? 'COURIER' : 'PICKUP';
    const fee = choice === 'COURIER' ? (ship.shippingFeePaise ?? 0) : 0;
    const saleId = uid();
    aSale[a.k] = saleId;
    const base = { id: saleId, auctionId: id, buyerId: mid[winner], sellerId: mid[a.seller], itemPaise: big(price), commissionPaise: big(commissionPaise), rateBps, payBy: new Date(endMs + 3 * D), createdAt: new Date(endMs) };
    const label = a.title;

    if (out.t === 'cancelled') {
      const cancelledAt = endMs + 3 * D;
      sales.push({ ...base, shippingFeePaise: big(0), amountPaise: big(price), status: 'CANCELLED', cancelledAt: new Date(cancelledAt) });
      saleInfo[saleId] = { buyer: winner, seller: a.seller, status: 'CANCELLED', paidAt: null };
      const strikeId = uid();
      strikes.push({
        id: strikeId,
        memberId: mid[winner],
        saleId,
        reason: 'UNPAID',
        createdAt: new Date(cancelledAt),
        expiresAt: strikeExpiry(new Date(cancelledAt)),
        removedAt: out.removed ? new Date(cancelledAt + 2 * D) : null,
        removedById: out.removed ? adminId : null,
        note: out.removed ? 'Buyer proved a payment failure on the bank side. Strike removed.' : null,
      });
      note('sale-cancelled', winner, 'Sale cancelled', `The sale of "${label}" was cancelled because it was not paid in time.`, `/purchases/${saleId}`, cancelledAt);
      note('strike-issued', winner, 'Strike issued', 'A strike was added to your account for an unpaid sale.', '/purchases', cancelledAt + 1000, { depositsRequired: false });
      note('sale-cancelled', a.seller, 'Sale cancelled', `The buyer of "${label}" did not pay. You can relist it.`, `/sell/sales/${saleId}`, cancelledAt);
      if (a.deposit) {
        const dp = R(a.deposit);
        const po = order(winner, dp, 'DEPOSIT', `${a.k}:${winner}`, 'PAID', startMs + 2 * D);
        deposits.push({ id: uid(), auctionId: id, memberId: mid[winner], amountPaise: big(dp), status: 'FORFEITED', paymentOrderId: po.id, gatewayPaymentId: po.payId, heldAt: new Date(startMs + 2 * D), forfeitedAt: new Date(cancelledAt), createdAt: new Date(startMs + 2 * D) });
        invoiceReqs.push({ type: 'DEPOSIT_FORFEIT', refId: deposits[deposits.length - 1].id as string, memberKey: winner, total: dp, issuedAt: cancelledAt + H });
        note('deposit-forfeited', winner, 'Bid deposit forfeited', `Your deposit of ${inr(dp)} for "${label}" was forfeited because the sale was not paid.`, `/auctions/${id}`, cancelledAt + H);
        const runner = [...sim.maxes.keys()].find((k) => k !== winner)!;
        const po2 = order(runner, dp, 'DEPOSIT', `${a.k}:${runner}`, 'PAID', startMs + 2 * D);
        deposits.push({ id: uid(), auctionId: id, memberId: mid[runner], amountPaise: big(dp), status: 'REFUNDED', paymentOrderId: po2.id, gatewayPaymentId: po2.payId, refundId: `rfnd_demo_${po2.id.slice(0, 12)}`, heldAt: new Date(startMs + 2 * D), refundedAt: new Date(endMs + H), createdAt: new Date(startMs + 2 * D) });
        note('deposit-refunded', runner, 'Bid deposit refunded', `Your deposit of ${inr(dp)} for "${label}" was refunded.`, `/auctions/${id}`, endMs + H);
      }
      if (out.offer) {
        const runner = [...sim.maxes.entries()].filter(([k]) => k !== winner).sort((x, y) => y[1] - x[1])[0];
        const offerAmount = runner[1];
        const offerId = uid();
        const created = cancelledAt;
        const status = out.offer === 'ACCEPTED_AWAIT' || out.offer === 'ACCEPTED_PAID' ? 'ACCEPTED' : out.offer;
        let newSaleId: string | null = null;
        if (status === 'ACCEPTED') {
          newSaleId = uid();
          const respondedAt = created + 5 * H;
          const comm2 = Math.round((offerAmount * rateBps) / 10_000);
          const paid = out.offer === 'ACCEPTED_PAID';
          const po = order(runner[0], offerAmount, 'SALE', newSaleId, paid ? 'PAID' : 'CREATED', respondedAt);
          sales.push({
            id: newSaleId,
            auctionId: id,
            buyerId: mid[runner[0]],
            sellerId: mid[a.seller],
            itemPaise: big(offerAmount),
            shippingFeePaise: big(0),
            amountPaise: big(offerAmount),
            commissionPaise: big(comm2),
            rateBps,
            status: paid ? 'PAID' : 'AWAITING_PAYMENT',
            payBy: new Date(respondedAt + 3 * D),
            paidAt: paid ? new Date(respondedAt + 6 * H) : null,
            gatewayPaymentId: paid ? po.payId : null,
            transferId: paid ? `trf_demo_${newSaleId.slice(0, 12)}` : null,
            createdAt: new Date(respondedAt),
          });
          saleInfo[newSaleId] = { buyer: runner[0], seller: a.seller, status: paid ? 'PAID' : 'AWAITING_PAYMENT', paidAt: paid ? respondedAt + 6 * H : null };
          auctions[auctions.length - 1].winnerId = mid[runner[0]];
          if (paid) {
            commissions.push({ id: uid(), auctionId: id, sellerId: mid[a.seller], rateBps, amountPaise: big(comm2), status: 'PAID', dueAt: new Date(respondedAt + 7 * D), paidAt: new Date(respondedAt + 6 * H), paymentOrderId: po.id, createdAt: new Date(respondedAt) });
            note('sale-paid', a.seller, 'Buyer paid for your item', `The second-chance buyer paid ${inr(offerAmount)} for "${label}".`, `/sell/sales/${newSaleId}`, respondedAt + 6 * H);
          }
          note('second-chance-accepted', a.seller, 'Second-chance offer accepted', `The runner-up accepted your second-chance offer for "${label}".`, `/sell/sales/${newSaleId}`, respondedAt);
        }
        offers.push({
          id: offerId,
          saleId,
          auctionId: id,
          bidderId: mid[runner[0]],
          amountPaise: big(offerAmount),
          status,
          expiresAt: new Date(created + 48 * H),
          respondedAt: status === 'ACCEPTED' ? new Date(created + 5 * H) : status === 'DECLINED' ? new Date(created + 8 * H) : null,
          newSaleId,
          createdAt: new Date(created),
        });
        note('second-chance-offer', runner[0], 'Second-chance offer', `You can still buy "${label}" for ${inr(offerAmount)}. The offer expires in 48 hours.`, `/purchases/offers`, created + 2000, { amountPaise: offerAmount });
        if (status === 'DECLINED') note('second-chance-declined', a.seller, 'Second-chance offer declined', `The runner-up declined your offer for "${label}".`, `/auctions/${id}`, created + 8 * H);
      }
      continue;
    }

    // out.t === 'sale'
    const st = out.st;
    const paidAt = endMs + 3 * H + (n % 5) * H;
    const base2 = { ...base };
    if (st === 'AWAITING_PAYMENT') {
      sales.push({ ...base2, shippingFeePaise: big(0), amountPaise: big(price), status: st });
      order(winner, price, 'SALE', saleId, 'CREATED', endMs + H);
      saleInfo[saleId] = { buyer: winner, seller: a.seller, status: st, paidAt: null };
      continue;
    }
    const total = price + fee;
    const po = order(winner, total, 'SALE', saleId, 'PAID', paidAt);
    const shippedAt = paidAt + D;
    const deliveredAt = shippedAt + 3 * D;
    const row: Record<string, unknown> = {
      ...base2,
      shippingFeePaise: big(fee),
      deliveryChoice: choice,
      amountPaise: big(total),
      status: st,
      paidAt: new Date(paidAt),
      gatewayPaymentId: po.payId,
      transferId: `trf_demo_${saleId.slice(0, 12)}`,
    };
    if (['SHIPPED', 'DELIVERED', 'RELEASED', 'DISPUTED'].includes(st)) {
      row.shippingMethod = choice;
      if (choice === 'COURIER') {
        row.courier = ['Delhivery', 'Blue Dart', 'DTDC', 'India Post'][n % 4];
        row.trackingNo = `DEMO${String(7_000_000_000 + n * 7919)}`;
      }
      row.shippedAt = new Date(shippedAt);
    }
    if (st === 'DELIVERED' || st === 'RELEASED') row.deliveredAt = new Date(deliveredAt);
    if (st === 'RELEASED') {
      row.releasedAt = new Date(deliveredAt + D);
      row.transferId = `trf_demo_${saleId.slice(0, 12)}`;
    }
    if (st === 'DISPUTED') {
      row.disputedAt = new Date(shippedAt + 2 * D);
      row.disputeReason = 'Item received does not match the description: the box was open and earbuds look used.';
    }
    if (st === 'REFUNDED') {
      row.disputedAt = new Date(paidAt + D);
      row.disputeReason = 'Item never arrived.';
      row.resolvedAt = new Date(paidAt + 3 * D);
      row.resolution = 'Refunded to the buyer by admin.';
      row.refundedAt = new Date(paidAt + 3 * D);
    }
    sales.push(row);
    saleInfo[saleId] = { buyer: winner, seller: a.seller, status: st, paidAt };
    note('sale-receipt', winner, 'Payment receipt', `We received ${inr(total)} for "${label}".`, `/purchases/${saleId}`, paidAt);
    note('sale-paid', a.seller, 'Buyer paid for your item', `The buyer paid ${inr(total)} for "${label}". Please ship it.`, `/sell/sales/${saleId}`, paidAt);
    if (['PAID', 'SHIPPED', 'DELIVERED', 'RELEASED'].includes(st)) {
      commissions.push({ id: uid(), auctionId: id, sellerId: mid[a.seller], rateBps, amountPaise: big(commissionPaise), status: 'PAID', dueAt: new Date(endMs + 7 * D), paidAt: new Date(paidAt), paymentOrderId: po.id, createdAt: new Date(endMs) });
    }
    if (['SHIPPED', 'DELIVERED', 'RELEASED'].includes(st)) note('sale-shipped', winner, 'Item shipped', `"${label}" is on its way${row.courier ? ` with ${row.courier}` : ''}.`, `/purchases/${saleId}`, shippedAt);
    if (st === 'RELEASED') note('sale-released', a.seller, 'Payout released', `Your payout for "${label}" was released.`, `/sell/sales/${saleId}`, deliveredAt + D);
    if (st === 'DISPUTED') note('sale-disputed', a.seller, 'Sale disputed', `The buyer opened a dispute on "${label}".`, `/sell/sales/${saleId}`, shippedAt + 2 * D);
    if (st === 'REFUNDED') note('sale-refunded', winner, 'Payment refunded', `Your payment of ${inr(total)} for "${label}" was refunded.`, `/purchases/${saleId}`, paidAt + 3 * D);

    if (out.review) {
      const rv = out.review;
      const rid = uid();
      reviewIdByAuction[a.k] = rid;
      const createdAt = deliveredAt + D;
      reviews.push({
        id: rid,
        auctionId: id,
        sellerId: mid[a.seller],
        reviewerId: mid[winner],
        rating: rv.rating,
        comment: rv.comment,
        sellerReply: rv.reply ?? null,
        sellerRepliedAt: rv.reply ? new Date(createdAt + 4 * H) : null,
        hiddenAt: rv.hidden ? new Date(createdAt + 2 * D) : null,
        createdAt: new Date(createdAt),
      });
      if (!rv.hidden) {
        ctr(a.seller).ratingCount += 1;
        ctr(a.seller).ratingSum += rv.rating;
      }
      note('review-received', a.seller, 'New review on your profile', `${memberName[winner]} rated you ${rv.rating} star${rv.rating > 1 ? 's' : ''}.`, `/sellers/${mid[a.seller]}`, createdAt, { rating: rv.rating });
    }
    // deposits on completed sales: all refunded
    if (a.deposit) {
      const dp = R(a.deposit);
      for (const bidder of sim.maxes.keys()) {
        const po2 = order(bidder, dp, 'DEPOSIT', `${a.k}:${bidder}`, 'PAID', startMs + D);
        deposits.push({ id: uid(), auctionId: id, memberId: mid[bidder], amountPaise: big(dp), status: 'REFUNDED', paymentOrderId: po2.id, gatewayPaymentId: po2.payId, refundId: `rfnd_demo_${po2.id.slice(0, 12)}`, heldAt: new Date(startMs + D), refundedAt: new Date(bidder === winner ? paidAt + H : endMs + 2 * H), createdAt: new Date(startMs + D) });
        note('deposit-refunded', bidder, 'Bid deposit refunded', `Your deposit of ${inr(dp)} for "${label}" was refunded.`, `/auctions/${id}`, endMs + 2 * H);
      }
    }
  }

  // ---- deposits on live / scheduled auctions
  const liveDeposits: [string, string, 'HELD' | 'PENDING'][] = [
    ['L5', 'b09', 'HELD'], ['L5', 'b10', 'HELD'], ['L5', 'b11', 'HELD'], ['L5', 'b13', 'PENDING'],
    ['L7', 'b14', 'HELD'], ['L7', 'b15', 'HELD'], ['L7', 'b16', 'PENDING'],
    ['L8', 'b17', 'HELD'], ['L8', 'b18', 'HELD'],
  ];
  for (const [ak, bidder, status] of liveDeposits) {
    const sp = SP.find((x) => x.k === ak)!;
    const dp = R(sp.deposit!);
    const heldMs = NOW + sp.s * H + 2 * H;
    let paymentOrderId: string | null = null;
    let gatewayPaymentId: string | null = null;
    if (status === 'HELD') {
      const po = order(bidder, dp, 'DEPOSIT', `${ak}:${bidder}`, 'PAID', heldMs);
      paymentOrderId = po.id;
      gatewayPaymentId = po.payId;
      note('deposit-held', bidder, 'Bid deposit held', `Your deposit of ${inr(dp)} for "${sp.title}" is held. It is refunded when the auction ends.`, `/auctions/${aid[ak]}`, heldMs);
    }
    deposits.push({ id: uid(), auctionId: aid[ak], memberId: mid[bidder], amountPaise: big(dp), status, paymentOrderId, gatewayPaymentId, heldAt: status === 'HELD' ? new Date(heldMs) : null, createdAt: new Date(heldMs) });
  }

  // ============================================================ featured purchases (+ credits)
  const FEATURE_PRICE: Record<number, number> = { 1: 9900, 3: 24900, 7: 49900 };
  const featPlan: { ak: string; status: 'PAID' | 'PENDING' | 'FAILED'; with?: 'RAZORPAY' | 'CREDITS'; days: number; agoH: number }[] = [
    { ak: 'L3', status: 'PAID', with: 'RAZORPAY', days: 3, agoH: 48 },
    { ak: 'L5', status: 'PAID', with: 'RAZORPAY', days: 7, agoH: 24 },
    { ak: 'L7', status: 'PAID', with: 'RAZORPAY', days: 7, agoH: 30 },
    { ak: 'L8', status: 'PAID', with: 'CREDITS', days: 3, agoH: 20 },
    { ak: 'S3', status: 'PAID', with: 'CREDITS', days: 3, agoH: 6 },
    { ak: 'Q3', status: 'PAID', with: 'RAZORPAY', days: 1, agoH: 9 * 24 },
    { ak: 'Q4', status: 'PAID', with: 'RAZORPAY', days: 3, agoH: 12 * 24 },
    { ak: 'S1', status: 'PENDING', days: 3, agoH: 3 },
    { ak: 'L2', status: 'FAILED', days: 1, agoH: 40 },
  ];
  const creditGrants: { m: string; amount: number; reason: string; refType?: string; refId?: string; note?: string; atMs: number }[] = [];
  for (const f of featPlan) {
    const seller = aSeller[f.ak];
    const amount = FEATURE_PRICE[f.days];
    const pid = uid();
    const createdMs = NOW - f.agoH * H;
    let paymentOrderId: string | null = null;
    if (f.with === 'RAZORPAY') paymentOrderId = order(seller, amount, 'FEATURE', pid, 'PAID', createdMs).id;
    else if (f.status !== 'PAID') paymentOrderId = order(seller, amount, 'FEATURE', pid, f.status === 'FAILED' ? 'FAILED' : 'CREATED', createdMs).id;
    features.push({ id: pid, auctionId: aid[f.ak], sellerId: mid[seller], days: f.days, amountPaise: big(amount), status: f.status, paidWith: f.with ?? null, paymentOrderId, paidAt: f.status === 'PAID' ? new Date(createdMs) : null, createdAt: new Date(createdMs) });
    if (f.status === 'PAID') {
      invoiceReqs.push({ type: 'FEATURE', refId: pid, memberKey: seller, total: amount, issuedAt: createdMs });
      note('feature-activated', seller, 'Featured listing activated', `"${aTitle[f.ak]}" is featured for ${f.days} day${f.days > 1 ? 's' : ''}.`, `/auctions/${aid[f.ak]}`, createdMs);
      if (f.with === 'CREDITS') creditGrants.push({ m: seller, amount: -amount, reason: 'FEATURE_PURCHASE', refType: 'FEATURE_PURCHASE', refId: pid, atMs: createdMs });
    }
  }

  // ============================================================ referrals + credit ledger
  const refPlan: [string, string, 'PENDING' | 'QUALIFIED' | 'REWARDED' | 'REJECTED'][] = [
    ['s01', 'b01', 'REWARDED'], ['s01', 'b02', 'REWARDED'], ['s01', 'b03', 'QUALIFIED'],
    ['s02', 'b04', 'REWARDED'], ['s02', 'b05', 'PENDING'], ['s03', 'b08', 'REWARDED'],
    ['b01', 'b06', 'REWARDED'], ['b01', 'b07', 'QUALIFIED'], ['b02', 'b09', 'PENDING'], ['b02', 'b10', 'REJECTED'],
  ];
  const referralRows: Record<string, unknown>[] = [];
  const memberAge: Record<string, number> = {};
  memberKeys.forEach((k, i) => (memberAge[k] = k[0] === 's' ? 85 - (Number(k.slice(1)) % 5) * 3 : 70 - ((Number(k.slice(1)) * 3) % 40)));
  for (const [ref, referee, status] of refPlan) {
    const rid = uid();
    const createdMs = NOW - memberAge[referee] * D;
    const qualifiedAt = status === 'PENDING' ? null : new Date(createdMs + 5 * D);
    const rewardedAt = status === 'REWARDED' ? createdMs + 6 * D : null;
    referralRows.push({ id: rid, referrerId: mid[ref], refereeId: mid[referee], status, qualifiedAt, rewardedAt: rewardedAt ? new Date(rewardedAt) : null, rejectReason: status === 'REJECTED' ? 'SAME_DEVICE' : null, createdAt: new Date(createdMs) });
    if (status === 'REWARDED') {
      creditGrants.push({ m: ref, amount: 10000, reason: 'REFERRAL_REWARD', refType: 'REFERRAL', refId: rid, atMs: rewardedAt! });
      note('referral-rewarded', ref, 'Referral reward credited', `${memberName[referee]} joined with your code. Rs 100 credit added.`, '/profile?tab=referrals', rewardedAt!);
    }
  }
  // admin goodwill credits and corrections (+ and -)
  creditGrants.push({ m: 's01', amount: 50000, reason: 'ADMIN_ADJUSTMENT', note: 'Goodwill credit (demo)', atMs: NOW - 30 * D });
  creditGrants.push({ m: 's06', amount: 30000, reason: 'ADMIN_ADJUSTMENT', note: 'Seller onboarding bonus (demo)', atMs: NOW - 25 * D });
  creditGrants.push({ m: 's07', amount: 20000, reason: 'ADMIN_ADJUSTMENT', note: 'Goodwill credit (demo)', atMs: NOW - 12 * D });
  for (let i = 2; i <= 10; i++) creditGrants.push({ m: bk(i), amount: 5000 + i * 500, reason: 'ADMIN_ADJUSTMENT', note: 'Promotional credit (demo)', atMs: NOW - (20 - i) * D });
  for (const k of ['b05', 'b07']) creditGrants.push({ m: k, amount: -1000, reason: 'ADMIN_ADJUSTMENT', note: 'Correction (demo)', atMs: NOW - 5 * D });
  creditGrants.sort((x, y) => x.atMs - y.atMs);
  const bal = new Map<string, number>();
  for (const c of creditGrants) {
    const next = (bal.get(c.m) ?? 0) + c.amount;
    if (next < 0) throw new Error(`credit ledger for ${c.m} would go negative`);
    bal.set(c.m, next);
    credits.push({ id: uid(), memberId: mid[c.m], amountPaise: big(c.amount), reason: c.reason, refType: c.refType ?? null, refId: c.refId ?? null, note: c.note ?? null, createdById: c.reason === 'ADMIN_ADJUSTMENT' ? adminId : null, createdAt: new Date(c.atMs) });
  }

  // ============================================================ questions
  const QS = [
    ['Does it come with the original box and papers?', 'Yes, everything shown in the photos is included.'],
    ['Can you ship to Bengaluru, and how long will it take?', 'Yes, we ship across India within the days listed.'],
    ['Is there any damage not visible in the pictures?', 'Only the small wear mentioned in the description.'],
    ['Is the price negotiable if I pick it up in person?', null],
    ['Are there any hidden charges besides the shipping fee?', 'No, shipping and the bid amount are all you pay.'],
    ['Can I inspect the item before paying?', 'Pickup buyers can inspect it. Courier buyers can use the dispute option if it is not as described.'],
    ['Is GST invoice available for this purchase?', null],
    ['What is the exact size or dimension?', 'Please see the photos with a scale; I can add more on request.'],
    ['Buy this for 1000 now, DM me on WhatsApp for a cheaper deal.', null], // spam, hidden
    ['Is this item really original? Looks fake to me.', 'It is original, the invoice can be shared with the winner.'],
    ['When will the auction end exactly?', 'The end time is shown on the page and extends if a bid lands in the last two minutes.'],
    ['Is a warranty included?', null],
  ];
  const questionRows: Record<string, unknown>[] = [];
  const qTargets = ['L1', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L2', 'S1', 'S2', 'Q1', 'Q2', 'Q3', 'Q4', 'Q6', 'Q7', 'K1', 'K2', 'R1', 'X1', 'L1', 'L5', 'L7', 'L8'];
  const askers = BIDDERS.map((_, i) => bk(i + 1)).filter((k) => !SUSPENDED.has(k));
  qTargets.forEach((ak, i) => {
    const [q, ans] = QS[i % QS.length];
    const asker = askers[(i * 5 + 2) % askers.length];
    const createdMs = Math.min(NOW - 2 * H, NOW + SP.find((x) => x.k === ak)!.s * H + (i + 2) * H);
    const hidden = i === 8 || i === 20;
    const answered = !!ans && !hidden && i % 4 !== 3;
    const qid = uid();
    questionRows.push({
      id: qid,
      auctionId: aid[ak],
      askerId: mid[asker],
      question: q,
      answer: answered ? ans : null,
      answeredAt: answered ? new Date(createdMs + 3 * H) : null,
      hiddenAt: hidden ? new Date(createdMs + 6 * H) : null,
      createdAt: new Date(createdMs),
    });
    note('question-asked', aSeller[ak], 'Question on your lot', `${memberName[asker]} asked about "${aTitle[ak]}": ${q}`, `/auctions/${aid[ak]}`, createdMs, { question: q });
    if (answered) note('question-answered', asker, 'Your question was answered', `The seller answered your question on "${aTitle[ak]}".`, `/auctions/${aid[ak]}`, createdMs + 3 * H, { answer: ans });
  });

  // ============================================================ saved searches, watchlist, follows, preferences
  const SEARCHES: [string, string | null, string | null, Cond | null, number | null, number | null][] = [
    ['Film cameras', 'camera', 'Electronics', null, null, 15000],
    ['Silk sarees under 25k', 'saree', 'Fashion', 'NEW', null, 25000],
    ['Royal Enfield', 'enfield', 'Vehicles', null, 50000, 250000],
    ['Cricket memorabilia', 'cricket', 'Collectibles', null, null, null],
    ['Antique brass', 'brass', null, 'USED', null, 10000],
    ['Laptops', 'laptop', 'Electronics', null, 20000, 80000],
    ['Oil paintings', 'painting', 'Art', null, null, 30000],
    ['Silver jewellery', 'silver', 'Jewellery', null, null, 12000],
    ['Books and novels', 'novels', 'Books', null, null, 5000],
    ['Garden furniture', 'bench', 'Home & Garden', null, null, null],
    ['Headphones', 'headphones', 'Electronics', 'NEW', null, 15000],
    ['Guitars and instruments', 'guitar', null, null, null, 20000],
    ['Road bikes', 'bike', 'Sports', null, 20000, 80000],
    ['Handloom textiles', 'handloom', 'Fashion', null, null, null],
    ['Antique statues', 'statue', 'Collectibles', 'GOOD', null, 50000],
    ['Scooters', 'scooter', 'Vehicles', null, null, 150000],
    ['Fountain pens', 'pen', 'Other', null, null, 10000],
    ['Pottery', 'pottery', null, null, null, 8000],
    ['Treadmills', 'treadmill', 'Sports', 'USED', null, 25000],
    ['Cameras any condition', 'camera', null, null, null, null],
    ['Tablets', 'tablet', 'Electronics', null, null, 12000],
    ['Kurta and festive wear', 'kurta', 'Fashion', null, null, 6000],
  ];
  const savedSearchRows = SEARCHES.map(([name, q, category, condition, min, max], i) => ({
    id: uid(), memberId: mid[bk((i % 21) + 1)], name, q, category, condition, minPricePaise: min ? big(R(min)) : null, maxPricePaise: max ? big(R(max)) : null, createdAt: at(-(i + 3) * D),
  }));
  SEARCHES.slice(0, 5).forEach(([name], i) => {
    const target = ['L1', 'L3', 'L7', 'L5', 'S2'][i];
    note('saved-search-match', bk(i + 1), 'New listing matches a saved search', `"${aTitle[target]}" matches your saved search "${name}".`, `/auctions/${aid[target]}`, NOW - (i + 1) * 6 * H, { searchName: name });
  });

  const watchTargets = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'S1', 'S2', 'S3'];
  const watchRows: Record<string, unknown>[] = [];
  const seenWatch = new Set<string>();
  for (let i = 1; i <= 21; i++) {
    for (const off of [0, 3, 7]) {
      const ak = watchTargets[(i + off) % watchTargets.length];
      const key = `${i}:${ak}`;
      if (seenWatch.has(key) || aSeller[ak] === bk(i)) continue;
      seenWatch.add(key);
      const soon = ak === 'L3' || ak === 'L4';
      watchRows.push({ memberId: mid[bk(i)], auctionId: aid[ak], createdAt: at(-(i + off) * H), endingSoonNotifiedAt: soon ? at(-20 * 60_000) : null });
      if (soon && i % 2 === 1) note('ending-soon', bk(i), 'Auction ending soon', `"${aTitle[ak]}" on your watchlist ends within the hour.`, `/auctions/${aid[ak]}`, NOW - 20 * 60_000);
    }
  }

  const followRows: Record<string, unknown>[] = [];
  const seenFollow = new Set<string>();
  const addFollow = (f: string, s: string, agoD: number) => {
    const key = `${f}>${s}`;
    if (seenFollow.has(key)) return;
    seenFollow.add(key);
    followRows.push({ followerId: mid[f], sellerId: mid[s], createdAt: at(-agoD * D) });
    ctr(s).followers += 1;
  };
  for (let i = 1; i <= 21; i++) addFollow(bk(i), sk(((i - 1) % 8) + 1), 5 + i);
  for (let i = 1; i <= 8; i++) addFollow(bk(i), sk(((i + 3) % 8) + 1), 2 + i);
  note('followed-seller-listed', 'b01', 'A seller you follow listed an item', `Rajesh Kumar Antiques listed "${aTitle.S3}".`, `/auctions/${aid.S3}`, NOW - 5 * H);
  note('followed-seller-listed', 'b02', 'A seller you follow listed an item', `Rajesh Kumar Antiques listed "${aTitle.S3}".`, `/auctions/${aid.S3}`, NOW - 5 * H);

  const PREF_TYPES = ['outbid', 'ending-soon', 'saved-search-match', 'followed-seller-listed', 'question-answered', 'review-received', 'question-asked', 'feature-activated', 'referral-rewarded'];
  const prefRows: Record<string, unknown>[] = [];
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 2; j++) {
      const type = PREF_TYPES[(i + j * 4) % PREF_TYPES.length];
      prefRows.push({ memberId: mid[bk(i + 1)], type, email: (i + j) % 3 !== 0, push: (i * 2 + j) % 4 !== 1 });
    }
  }

  // ============================================================ payout accounts
  const payoutPlan: [string, 'ACTIVE' | 'PENDING' | 'REJECTED' | 'NEEDS_CLARIFICATION', string | null][] = [
    ['s01', 'ACTIVE', null], ['s02', 'ACTIVE', null], ['s03', 'ACTIVE', null], ['s04', 'ACTIVE', null], ['s05', 'ACTIVE', null], ['s06', 'ACTIVE', null],
    ['s07', 'PENDING', 'KYC under review'], ['s08', 'REJECTED', 'Bank account name does not match the business name'],
  ];
  const payoutRows = payoutPlan.map(([k, status, statusReason], i) => {
    const key = crypto.createHash('sha1').update(mid[k]).digest('hex').slice(0, 14);
    return {
      id: uid(), sellerId: mid[k], razorpayAccountId: `acc_stub_${key}`, productId: `acc_prd_stub_${key}`, status, statusReason,
      legalName: memberName[k], businessType: i % 2 === 0 ? 'individual' : 'proprietorship', bankLast4: String(1000 + i * 1111).slice(0, 4), ifsc: `HDFC000${1000 + i}`, beneficiaryName: memberName[k], createdAt: at(-60 * D),
    };
  });

  // ============================================================ reports (3 reporters on L3 = high priority)
  const reportRows: Record<string, unknown>[] = [];
  type RS = 'OPEN' | 'ACTION_TAKEN' | 'DISMISSED';
  const rep = (reporter: string, targetType: 'AUCTION' | 'MEMBER' | 'REVIEW' | 'QUESTION', targetId: string, reason: string, status: RS, details: string | null, ageH: number, note?: string) =>
    reportRows.push({
      id: uid(), reporterId: mid[reporter], targetType, targetId, reason, details, status,
      resolvedById: status === 'OPEN' ? null : adminId, resolvedAt: status === 'OPEN' ? null : at(-(ageH - 5) * H), note: status === 'OPEN' ? null : (note ?? null), createdAt: at(-ageH * H),
    });
  rep('b01', 'AUCTION', aid.L3, 'COUNTERFEIT', 'OPEN', 'The zari looks machine-made, not Banarasi handloom.', 30);
  rep('b02', 'AUCTION', aid.L3, 'MISLEADING', 'OPEN', 'Photos are copied from another website.', 20);
  rep('b03', 'AUCTION', aid.L3, 'MISLEADING', 'OPEN', null, 10);
  rep('b10', 'AUCTION', aid.L5, 'PROHIBITED', 'OPEN', 'Autographs of this kind should have an authenticity proof.', 50);
  rep('b12', 'AUCTION', aid.L7, 'MISLEADING', 'ACTION_TAKEN', 'Listing says single owner but the RC shows two.', 100, 'Seller asked to correct the listing. Done.');
  rep('b13', 'AUCTION', aid.S2, 'SPAM', 'DISMISSED', 'Looks like a repeated listing.', 90, 'Not a duplicate.');
  rep('b05', 'AUCTION', aid.C2, 'OTHER', 'ACTION_TAKEN', 'Seller took money outside the platform.', 150, 'Listing cancelled and seller suspended.');
  rep('b16', 'AUCTION', aid.L8, 'MISLEADING', 'OPEN', 'Battery health seems overstated.', 14);
  rep('b04', 'MEMBER', mid.s08, 'ABUSE', 'OPEN', 'Rude and threatening on the Q&A.', 40);
  rep('b14', 'MEMBER', mid.b20, 'ABUSE', 'ACTION_TAKEN', 'Won an item and then abused the seller over chat.', 300, 'Account suspended after three strikes.');
  rep('b05', 'MEMBER', mid.s09, 'COUNTERFEIT', 'ACTION_TAKEN', 'Sold fake branded goods in an earlier auction.', 200, 'Suspended.');
  rep('s02', 'MEMBER', mid.b19, 'SPAM', 'DISMISSED', 'Sent the same message to many of my listings.', 120, 'Normal bidder behaviour.');
  rep('b08', 'MEMBER', mid.s07, 'OTHER', 'OPEN', 'Slow to respond and late shipping.', 25);
  rep('s04', 'MEMBER', mid.b16, 'ABUSE', 'OPEN', 'Asked for my phone number repeatedly.', 8);
  rep('s01', 'REVIEW', reviewIdByAuction.Q5, 'ABUSE', 'ACTION_TAKEN', 'Review contains personal remarks.', 160, 'Review hidden.');
  rep('s06', 'REVIEW', reviewIdByAuction.Q7, 'OTHER', 'DISMISSED', 'Review is unfair about delivery time.', 130, 'Courier delay is a valid point.');
  rep('s04', 'REVIEW', reviewIdByAuction.Q4, 'SPAM', 'OPEN', 'Suspicious five-star review.', 15);
  const qIds = questionRows.map((q) => q.id as string);
  rep('b17', 'QUESTION', qIds[8], 'SPAM', 'ACTION_TAKEN', 'Asks users to move to WhatsApp.', 60, 'Question hidden.');
  rep('b18', 'QUESTION', qIds[2], 'OTHER', 'OPEN', 'Unrelated to the item.', 18);
  rep('s03', 'QUESTION', qIds[9], 'ABUSE', 'DISMISSED', 'Accuses me of fraud.', 70, 'Fair question, answered politely.');
  rep('b11', 'QUESTION', qIds[19], 'SPAM', 'OPEN', null, 9);
  rep('b21', 'AUCTION', aid.L2, 'OTHER', 'OPEN', 'Price seems too good to be true.', 5);

  // ============================================================ shill signals
  const shill: [string, string, RiskReason[], 'DISMISSED' | 'ACTION_TAKEN' | null][] = [
    ['L3', 'b04', ['SHARED_DEVICE', 'NEW_ACCOUNT_SINGLE_SELLER'], null],
    ['L5', 'b11', ['SHARED_IP'], null],
    ['L7', 'b15', ['SHARED_DEVICE', 'SHARED_IP'], null],
    ['L8', 'b18', ['SHARED_IP', 'NEW_ACCOUNT_SINGLE_SELLER'], null],
    ['L1', 'b02', ['CONCENTRATION'], null],
    ['Q3', 'b07', ['NEVER_WINS'], 'DISMISSED'],
    ['Q4', 'b09', ['CONCENTRATION', 'NEVER_WINS'], 'ACTION_TAKEN'],
    ['X4', 'b20', ['SHARED_DEVICE'], 'ACTION_TAKEN'],
    ['Q5', 'b10', ['SHARED_IP'], 'DISMISSED'],
    ['Q6', 'b12', ['CONCENTRATION'], null],
    ['Q7', 'b13', ['NEW_ACCOUNT_SINGLE_SELLER'], 'DISMISSED'],
    ['Q9', 'b08', ['NEVER_WINS', 'SHARED_IP'], null],
    ['X2', 'b05', ['SHARED_DEVICE', 'CONCENTRATION'], 'ACTION_TAKEN'],
    ['K2', 'b14', ['NEVER_WINS'], null],
  ];
  const shillRows = shill.map(([ak, bidder, reasons, outcome], i) => ({
    id: uid(), auctionId: aid[ak], bidderId: mid[bidder], sellerId: mid[aSeller[ak]], score: scoreOf(reasons), reasons,
    createdAt: at(-(i + 2) * 7 * H), reviewedAt: outcome ? at(-(i + 1) * 4 * H) : null, reviewedById: outcome ? adminId : null, outcome,
    note: outcome === 'ACTION_TAKEN' ? 'Confirmed link between bidder and seller. Warned both.' : outcome === 'DISMISSED' ? 'Coincidence, no link found.' : null,
  }));
  for (const s of shill) if (!aSim[s[0]].maxes.has(s[1])) throw new Error(`shill signal ${s[0]}/${s[1]}: bidder did not bid`);

  // ============================================================ daily stats (14 days) + a few viewer rows
  const statRows: Record<string, unknown>[] = [];
  const viewerRows: Record<string, unknown>[] = [];
  const todayMs = istDate(NOW).getTime();
  for (const a of SP) {
    if (!['s01', 's02', 's03', 's04'].includes(a.seller) || a.status === 'SCHEDULED' || a.status === 'CANCELLED') continue;
    const first = Math.max(istDate(NOW + a.s * H).getTime(), todayMs - 13 * D);
    const last = Math.min(istDate(NOW + a.e * H).getTime(), todayMs);
    for (let d = first, i = 0; d <= last; d += D, i++) {
      const views = rint(12, 40) + i * rint(2, 6) + (a.feat ? 25 : 0);
      const isRecent = todayMs - d <= D && a.status === 'LIVE' && ['L1', 'L3', 'L5', 'L7'].includes(a.k);
      const unique = isRecent ? rint(3, 6) : Math.max(1, Math.round(views * (0.55 + rnd() * 0.25)));
      statRows.push({ auctionId: aid[a.k], date: new Date(d), views, uniqueViewers: unique });
      if (isRecent) for (let v = 0; v < unique; v++) viewerRows.push({ auctionId: aid[a.k], viewerKey: crypto.createHash('sha256').update(`demo-viewer-${a.k}-${v}-${d}`).digest('hex'), date: new Date(d) });
    }
  }

  // ============================================================ members with their final counters
  const memberRows = memberKeys.map((k, i) => {
    const isB = k[0] === 'b';
    const idx = Number(k.slice(1));
    const [name, city, state, gstin] = isB ? [BIDDERS[idx - 1][0], BIDDERS[idx - 1][1], BIDDERS[idx - 1][2], null] : SELLERS[idx - 1];
    const c = counters.get(k);
    return {
      id: mid[k],
      email: emailOf(k),
      name,
      passwordHash,
      phone: `98${String(76_000_000 + i * 1371).padStart(8, '0')}`,
      address: `${12 + i}, MG Road, ${city}`,
      role: 'MEMBER',
      isActive: !SUSPENDED.has(k),
      emailVerifiedAt: at(-memberAge[k] * D),
      verifiedAt: VERIFIED.has(k) ? at(-30 * D) : null,
      verificationRevokedAt: k === 's08' ? at(-3 * D) : null,
      unpaidCommissionPaise: big(c?.unpaid ?? 0),
      auctionsWon: c?.auctionsWon ?? 0,
      moneySpentPaise: big(c?.moneySpent ?? 0),
      ratingCount: c?.ratingCount ?? 0,
      ratingSum: c?.ratingSum ?? 0,
      followerCount: c?.followers ?? 0,
      referralCode: !isB || ['b01', 'b02'].includes(k) ? refCode(k) : null,
      gstin: gstin ?? null,
      billingState: state,
      createdAt: at(-memberAge[k] * D),
    };
  });

  // ============================================================ notifications for the remaining members
  note('account-suspended', 'b20', 'Account suspended', 'Your account was suspended after three unpaid-sale strikes. Contact support.', '/contact', NOW - 16 * D, { strikeCount: 3 });
  for (const k of ['b20']) note('strike-issued', k, 'Strike issued', 'A strike was added to your account for an unpaid sale.', '/purchases', NOW - 17 * D);
  note('strike-issued', 'b18', 'Strike issued', 'Second strike: deposits are now required on every bid.', '/purchases', NOW - 9 * D, { strikeCount: 2, depositsRequired: true });
  for (const [i, k] of [...Array(21).keys()].map((n) => bk(n + 1)).entries()) {
    if (SUSPENDED.has(k) || notifs.some((x) => x.memberKey === k)) continue;
    const ak = ['L1', 'L3', 'L5', 'L6', 'L7'][i % 5];
    note('outbid', k, 'You have been outbid', `Someone bid higher on "${aTitle[ak]}". Place a higher bid to stay in the lead.`, `/auctions/${aid[ak]}`, NOW - (i + 1) * 3 * H);
  }

  // ============================================================ insert everything (one transaction, after cleaning)
  const result = await prisma.$transaction(
    async (tx: Tx) => {
      const cleaned = await cleanDemo(tx);
      await tx.member.createMany({ data: memberRows as never });
      await tx.sellerPayoutAccount.createMany({ data: payoutRows as never });
      await tx.auction.createMany({ data: auctions as never });
      await tx.bid.createMany({ data: bids as never });
      await tx.maxBid.createMany({ data: maxBidRows as never });
      await tx.paymentOrder.createMany({ data: orders as never });
      await tx.commission.createMany({ data: commissions as never });
      await tx.sale.createMany({ data: sales as never });
      await tx.strike.createMany({ data: strikes as never });
      await tx.secondChanceOffer.createMany({ data: offers as never });
      await tx.auctionDeposit.createMany({ data: deposits as never });
      await tx.review.createMany({ data: reviews as never });
      await tx.auctionQuestion.createMany({ data: questionRows as never });
      await tx.savedSearch.createMany({ data: savedSearchRows as never });
      await tx.watchlist.createMany({ data: watchRows as never });
      await tx.follow.createMany({ data: followRows as never });
      await tx.notificationPreference.createMany({ data: prefRows as never });
      await tx.featurePurchase.createMany({ data: features as never });
      await tx.referral.createMany({ data: referralRows as never });
      await tx.memberCredit.createMany({ data: credits as never });
      await tx.report.createMany({ data: reportRows as never });
      await tx.shillSignal.createMany({ data: shillRows as never });
      await tx.auctionStatDaily.createMany({ data: statRows as never });
      await tx.auctionViewer.createMany({ data: viewerRows as never });
      await tx.notification.createMany({
        data: notifs.map((n, i) => ({
          id: uid(),
          memberId: mid[n.memberKey],
          type: n.type,
          title: n.title,
          body: n.body,
          url: n.url,
          data: n.data as never,
          dedupeKey: `demo:${n.type}:${i}:${mid[n.memberKey]}`,
          readAt: i % 3 === 0 ? null : new Date(n.at + 2 * H > NOW ? NOW : n.at + 2 * H),
          createdAt: new Date(n.at),
        })),
      });

      // Invoices: the real numbering (InvoiceCounter + NB/<FY>/<seq>), in issue order, inside this transaction.
      const memberByKey = new Map(memberRows.map((m, i) => [memberKeys[i], m]));
      const nextSeq = new Map<string, number>();
      const invRows: Record<string, unknown>[] = [];
      for (const inv of [...invoiceReqs].sort((x, y) => x.issuedAt - y.issuedAt)) {
        const issued = new Date(inv.issuedAt);
        const fy = financialYearOf(issued);
        if (!nextSeq.has(fy)) {
          await tx.invoiceCounter.upsert({ where: { financialYear: fy }, create: { financialYear: fy, seq: 0 }, update: {} });
          nextSeq.set(fy, (await tx.invoiceCounter.findUniqueOrThrow({ where: { financialYear: fy } })).seq);
        }
        const seq = nextSeq.get(fy)! + 1;
        nextSeq.set(fy, seq);
        const m = memberByKey.get(inv.memberKey)!;
        const tax = computeInvoiceTax({ totalPaise: inv.total, platformGstin: platform.gstin, platformStateCode: platform.stateCode, buyerState: m.billingState, gstRateBps: platform.gstRateBps, inclusive: true });
        invRows.push({
          id: uid(), number: invoiceNumber(fy, seq), financialYear: fy, seq, type: inv.type, refId: inv.refId, memberId: m.id, buyerName: m.name, buyerGstin: m.gstin, buyerState: m.billingState,
          placeOfSupply: m.billingState ?? platform.stateCode, taxablePaise: big(tax.taxablePaise), cgstPaise: big(tax.cgstPaise), sgstPaise: big(tax.sgstPaise), igstPaise: big(tax.igstPaise),
          totalPaise: big(tax.totalPaise), isTaxInvoice: tax.isTaxInvoice, issuedAt: issued, pdfKey: null, createdAt: issued,
        });
      }
      await tx.invoice.createMany({ data: invRows as never });
      for (const [fy, seq] of nextSeq) await tx.invoiceCounter.update({ where: { financialYear: fy }, data: { seq } });
      return { cleaned, invoices: invRows.length };
    },
    { timeout: 300_000, maxWait: 30_000 },
  );

  const counts = {
    Member: memberRows.length, Auction: auctions.length, Bid: bids.length, MaxBid: maxBidRows.length, Watchlist: watchRows.length, Commission: commissions.length,
    Notification: notifs.length, PaymentOrder: orders.length, Review: reviews.length, AuctionQuestion: questionRows.length, SavedSearch: savedSearchRows.length,
    SellerPayoutAccount: payoutRows.length, Sale: sales.length, Report: reportRows.length, AuctionDeposit: deposits.length, Strike: strikes.length,
    SecondChanceOffer: offers.length, ShillSignal: shillRows.length, Follow: followRows.length, NotificationPreference: prefRows.length,
    AuctionStatDaily: statRows.length, AuctionViewer: viewerRows.length, FeaturePurchase: features.length, Referral: referralRows.length, MemberCredit: credits.length, Invoice: result.invoices,
  };
  console.log(`[seed-demo] replaced ${result.cleaned.members} old demo members / ${result.cleaned.auctions} old demo auctions`);
  console.log('[seed-demo] created rows:', JSON.stringify(counts));
  console.log(`[seed-demo] login: <bidderNN|sellerNN>${DEMO_DOMAIN} / ${DEMO_PASSWORD}`);
  for (const a of SP) {
    const s = aSim[a.k];
    console.log(`  ${a.k.padEnd(3)} ${a.status.padEnd(9)} bids=${String(s.bidCount).padStart(2)} price=${inr(s.price).padEnd(12)} winner=${aWinner[a.k] ?? '-'} ${a.title}`);
  }
}

main()
  .catch((err) => {
    console.error('[seed-demo] failed', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
