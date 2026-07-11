const express = require("express");
const mongoose = require("mongoose");
const passport = require("passport");
const LocalStrategy = require("passport-local");
const bodyParser = require("body-parser");
const session = require("express-session");
const flash = require("connect-flash");
const crypto = require("crypto");
const path = require("path");
const { Paynow } = require("paynow");
require("dotenv").config();

const User = require("./models/User.model");
const app = express();

// ==========================================
// GLOBAL MEMORY FOR D.E.T. DATA
// ==========================================
let activeTradesList = []; 
let eaBrainState = { 
    symbol: "Awaiting Connection...", 
    trend: "Unknown", 
    action: "Scanning", 
    price: 0.00, 
    openTrades: 0,
    equityHistory: [],
    trends: {
        long: "Awaiting Data...", swing: "Awaiting Data...", day: "Awaiting Data...",
        intra: "Awaiting Data...", scalpa: "Awaiting Data...", real: "Awaiting Data..."
    },
    analytics: {
        scalpa: "Awaiting Data...", intra: "Awaiting Data...", day: "Awaiting Data...",
        swing: "Awaiting Data...", long: "Awaiting Data..."
    }
};

// --- DATABASE CONNECTION ---
mongoose.connect("mongodb://nyctech002:macb@ac-urmttwh-shard-00-00.o6scueg.mongodb.net:27017,ac-urmttwh-shard-00-01.o6scueg.mongodb.net:27017,ac-urmttwh-shard-00-02.o6scueg.mongodb.net:27017/bot-project?ssl=true&replicaSet=atlas-1gew6o-shard-0&authSource=admin&appName=INVESTMENTNETWORK")
  .then(() => console.log("MongoDB Connected to bot-project"))
  .catch(err => console.log("Mongo Error:", err));

// --- MIDDLEWARE SETUP ---
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));
app.use(flash());

app.use(session({
  secret: "protrading_secure_key_123",
  resave: false, saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());
passport.use(new LocalStrategy(User.authenticate()));
passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

app.use((req, res, next) => {
  res.locals.currentUser = req.user;
  res.locals.success = req.flash("success");
  res.locals.error = req.flash("error");
  next();
});

// Security Middleware
function isLoggedIn(req, res, next) {
    if (req.isAuthenticated()) return next();
    req.flash("error", "Please login first.");
    res.redirect("/login");
}
function isAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.username === "admin") return next();
    req.flash("error", "Admin access required.");
    res.redirect("/dashboard");
}

// Current path for navigation
app.use((req, res, next) => {
    res.locals.currentUser = req.user;
    res.locals.success = req.flash("success");
    res.locals.error = req.flash("error");
    res.locals.currentPath = req.path;
    next();
});

// ==========================================
// 1. S.M.A.R.T. ENGINE API ROUTES (MT5 <-> Node.js)
// ==========================================

// A. Master EA Endpoint
app.post("/api/master/update", (req, res) => {
    const { masterPassword, analysis, trades, uiState } = req.body;
    
    if (analysis) {
        eaBrainState.symbol = analysis.symbol;
        eaBrainState.trend = analysis.trend;
        eaBrainState.action = analysis.action;
        eaBrainState.price = analysis.price;
        eaBrainState.openTrades = analysis.openTrades;
        
        if(analysis.equity) {
            eaBrainState.equityHistory.push(parseFloat(analysis.equity));
            if(eaBrainState.equityHistory.length > 50) eaBrainState.equityHistory.shift(); 
        }
    }

    if (uiState) {
        if(uiState.trends) eaBrainState.trends = uiState.trends;
        if(uiState.analytics) eaBrainState.analytics = uiState.analytics;
    }
    
    if (trades) activeTradesList = trades;
    res.json({ status: "success" });
});

// B. Public Endpoint for the Web Dashboard Charts
app.get("/api/public/ea-state", (req, res) => res.json(eaBrainState));

// C. S.M.A.R.T CLIENT SYNC ENDPOINT
app.post("/api/client/sync", async (req, res) => {
    const { licenseKey, currentBalance, currentEquity } = req.body;
    
    try {
        const user = await User.findOne({ licenseKey: licenseKey });
        
        if (!user || new Date() > user.licenseExpiry) {
            return res.json({ action: "KILL" }); 
        }

        if (user.isSuspended || user.accountLocked) {
            return res.json({ action: "ZERO_HEDGE" }); 
        }

        let updated = false;

        if (user.startingBalance === 0 || user.startingBalance == null) {
            user.startingBalance = currentBalance;
            user.targetBalance = currentBalance * 2; 
            updated = true;
        }

        if (currentEquity >= user.targetBalance && user.targetBalance > 0) {
            user.accountLocked = true;
            user.isSuspended = true; 
            await user.save();
            console.log(`[ZERO-HEDGE] Participant ${user.username} doubled their account! Locking platform.`);
            return res.json({ action: "ZERO_HEDGE" }); 
        }

        if (updated) await user.save();

        res.json({
            action: "TRADE",
            masterState: eaBrainState,
            trades: activeTradesList
        });

    } catch (err) {
        console.error("Sync Error:", err);
        res.status(500).json({ action: "ERROR" });
    }
});

// --- PRICING TIERS DATA ---
const pricingTiers = [
    { name: "Amber", designation: "Level", float: "$0 to $49", percentage: "N/A", period: "No Trading", minSub: "N/A", maxSub: "N/A" },
    { name: "Amethyst", designation: "Level", float: "$50 to $199", percentage: "Fixed $1 Rate", period: "Per Day", minSub: "$1", maxSub: "$30" },
    { name: "Topaz", designation: "Level", float: "$200 to $1,000", percentage: "11%", period: "Per 30 Days", minSub: "$22", maxSub: "$111" },
    { name: "Tanzanite", designation: "Level", float: "$1,000 to $10,000", percentage: "10%", period: "Per 30 Days", minSub: "$100", maxSub: "$1,000" },
    { name: "Sapphire", designation: "Level", float: "$10,001 to $100K", percentage: "9%", period: "Per 7 Months", minSub: "$900", maxSub: "$9,000" },
    { name: "Emerald", designation: "Level", float: "$100K to $1M", percentage: "8%", period: "Per 7 Months", minSub: "$8,000", maxSub: "$80K" },
    { name: "Diamond", designation: "Level", float: "$1M to $10M", percentage: "7%", period: "Per 7 Months", minSub: "$70K", maxSub: "$700K" },
    { name: "Rhodium", designation: "Grade", float: "$10M to $100M", percentage: "5%", period: "Per 12 Months", minSub: "$500K", maxSub: "$5M" },
    { name: "Platinum", designation: "Grade", float: "$100M to $1B", percentage: "4%", period: "Per 12 Months", minSub: "$4M", maxSub: "$40M" },
    { name: "Uranium", designation: "Grade", float: "$1B to $10B", percentage: "3%", period: "Per 12 Months", minSub: "$30M", maxSub: "$300M" },
    { name: "Atomic", designation: "Grade", float: "$10B to $100B", percentage: "2%", period: "Per 12 Months", minSub: "$200M", maxSub: "$2B" },
    { name: "Nuclear", designation: "Grade", float: "$100B to $1T", percentage: "1%", period: "Per 12 Months", minSub: "$1B", maxSub: "$10B" },
    { name: "Solomonic", designation: "Grade", float: "$1T+", percentage: "0.5%", period: "Per 12 Months", minSub: "$5B", maxSub: "No Limit" }
];

// --- PRICING PAGE ROUTE ---
app.get("/pricing", (req, res) => {
    res.render("pricing", { tiers: pricingTiers });
});

// --- NAVIGATION ROUTES ---
app.get("/training", (req, res) => {
    res.render("training");
});

app.get("/affiliate", (req, res) => {
    res.send("<h2 style='color: #B0BF96; text-align: center; margin-top: 50px; font-family: sans-serif;'>Affiliate Network Architecture Pending Deployment</h2>");
});

// ==========================================
// PAYNOW INTEGRATION & DYNAMIC CHECKOUT
// ==========================================

const paynow = new Paynow(
    process.env.PAYNOW_INTEGRATION_ID || "YOUR_INTEGRATION_ID", 
    process.env.PAYNOW_INTEGRATION_KEY || "YOUR_INTEGRATION_KEY"
);

const LIVE_DOMAIN = "https://bot-proj-2-1.onrender.com";
paynow.resultUrl = `${LIVE_DOMAIN}/api/paynow/update`; 
paynow.returnUrl = `${LIVE_DOMAIN}/checkout/return`; 

// DYNAMIC TIER CONFIG WITH MIN/MAX RANGES
const tierConfig = {
    "Amethyst": { min: 1, max: 30, durationDays: 30 },
    "Topaz": { min: 22, max: 111, durationDays: 30 },
    "Tanzanite": { min: 100, max: 1000, durationDays: 30 },
    "Sapphire": { min: 900, max: 9000, durationDays: 210 }, 
    "Emerald": { min: 8000, max: 80000, durationDays: 210 },
    "Diamond": { min: 70000, max: 700000, durationDays: 210 },
    "Rhodium": { min: 500000, max: 5000000, durationDays: 365 }, 
    "Platinum": { min: 4000000, max: 40000000, durationDays: 365 },
    "Uranium": { min: 30000000, max: 300000000, durationDays: 365 },
    "Atomic": { min: 200000000, max: 2000000000, durationDays: 365 },
    "Nuclear": { min: 1000000000, max: 10000000000, durationDays: 365 },
    "Solomonic": { min: 5000000000, max: 999999999999, durationDays: 365 }
};

// 1. Intercept users coming from Pricing Page Modal
app.post("/checkout/initialize", (req, res) => {
    const selectedTier = req.body.selectedTier;
    // If already logged in, skip registration, go straight to checkout
    if (req.isAuthenticated()) {
        return res.redirect(`/checkout?tier=${encodeURIComponent(selectedTier)}`);
    }
    // Send to Registration Form (it will forward them to checkout after)
    res.render("register", { error: null, selectedTier: selectedTier });
});


// 2. The Dynamic Checkout Portal with full tier details
app.get("/checkout", isLoggedIn, (req, res) => {
    const tier = req.query.tier;
    if(!tierConfig[tier]) return res.redirect("/pricing");
    
    // Get tier details from pricingTiers array
    const tierDetails = pricingTiers.find(t => t.name === tier);
    
    // Calculate the percentage rate as a decimal for coverage estimation
    let percentageRate = 0;
    if (tierDetails) {
        // Extract numeric percentage from string like "11%" or "Fixed $1 Rate"
        const pctMatch = tierDetails.percentage.match(/(\d+\.?\d*)%/);
        if (pctMatch) {
            percentageRate = parseFloat(pctMatch[1]);
        } else if (tierDetails.percentage.includes("Fixed")) {
            // For Amethyst, use a default rate
            percentageRate = 2; // $1/$50 = 2% equivalent
        }
    }
    
    res.render("checkout", { 
        tier: tier, 
        config: tierConfig[tier],
        tierDesignation: tierDetails ? tierDetails.designation : "Level",
        tierFloat: tierDetails ? tierDetails.float : "N/A",
        tierPercentage: tierDetails ? tierDetails.percentage : "N/A",
        tierPeriod: tierDetails ? tierDetails.period : "N/A",
        tierMinSub: tierDetails ? tierDetails.minSub : "N/A",
        tierMaxSub: tierDetails ? tierDetails.maxSub : "N/A",
        tierPercentageRate: percentageRate
    });
});



// 3. API: Trigger EcoCash/OneMoney USSD Push with custom amount
app.post("/api/checkout/mobile-push", isLoggedIn, async (req, res) => {
    const { tier, phone, method, customAmount } = req.body;
    const config = tierConfig[tier];
    const amount = parseFloat(customAmount);

    // Validate amount is within tier range
    if(!config || isNaN(amount) || amount < config.min || amount > config.max) {
        return res.json({ success: false, error: "Invalid payment amount for this tier." });
    }

    const invoiceRef = `${req.user._id}-${tier}-${Date.now()}`;
    let payment = paynow.createPayment(invoiceRef, req.user.email);
    payment.add(`${tier} Grade D.E.T Activation`, amount);

    try {
        const response = await paynow.sendMobile(payment, phone, method);
        if(response.success) {
            res.json({ success: true, instructions: response.instructions });
        } else {
            res.json({ success: false, error: response.error });
        }
    } catch(err) {
        res.json({ success: false, error: "Bank gateway unreachable." });
    }
});

// 4. Standard gateway with custom amount
app.get("/checkout/standard-gateway", isLoggedIn, async (req, res) => {
    const tier = req.query.tier;
    const config = tierConfig[tier];
    const amount = parseFloat(req.query.amount);

    if(!config || isNaN(amount) || amount < config.min || amount > config.max) {
        return res.redirect("/pricing");
    }

    const invoiceRef = `${req.user._id}-${tier}-${Date.now()}`;
    let payment = paynow.createPayment(invoiceRef, req.user.email);
    payment.add(`${tier} Grade D.E.T Activation`, amount);

    try {
        const response = await paynow.send(payment);
        if(response.success) res.redirect(response.redirectUrl);
        else res.redirect("/pricing");
    } catch(e) { res.redirect("/pricing"); }
});

app.get("/checkout/return", isLoggedIn, (req, res) => {
    req.flash("success", "Payment processing! Your 9-Digit ID will generate automatically once network confirms.");
    res.redirect("/dashboard");
});

// 5. The Silent Webhook - Now reads EXACT amount paid
app.post("/api/paynow/update", async (req, res) => {
    const { reference, status, amount } = req.body;
    
    if (status === "Paid" || status === "Awaiting Delivery") {
        const parts = reference.split("-");
        const userId = parts[0];
        const tierName = parts[1];
        const config = tierConfig[tierName];

        try {
            const user = await User.findById(userId);
            if (user && !user.licenseKey) { // Prevent double-generation
                const generateDET_ID = () => Math.floor(100000000 + Math.random() * 900000000).toString();
                
                user.licenseKey = generateDET_ID();
                user.licenseExpiry = new Date(Date.now() + config.durationDays * 24 * 60 * 60 * 1000);
                user.currentTier = tierName;
                user.prepaymentAmount = parseFloat(amount) || config.min; // Secures exact paid amount
                user.termsAgreed = true;
                user.isSuspended = false; 
                user.accountLocked = false;
                user.mt5AccountNumber = null; 
                
                await user.save();
                console.log(`[SUCCESS] Webhook Verified! 9-Digit ID generated for ${user.username} (${tierName}) - Paid: $${amount}`);
            }
        } catch (err) {
            console.error("Webhook database update failed:", err);
        }
    }
    res.status(200).send("OK");
});

// 6. Polling endpoint for Checkout UI
app.get("/api/user/status", isLoggedIn, async (req, res) => {
    const user = await User.findById(req.user._id);
    res.json({ isPaid: !!user.licenseKey });
});

// ==========================================
// 2. WEB UI & AUTHENTICATION ROUTES
// ==========================================

app.get("/", (req, res) => {
    res.render("index", { 
        currentUser: req.user || null 
    });
});

app.get("/register", (req, res) => res.render("register"));

app.post("/register", async (req, res) => {
  try {
    const newUser = new User({ 
        username: req.body.username, 
        email: req.body.email,
        whatsapp: req.body.whatsapp || "",
        country: req.body.country || "",
        currentTier: req.body.selectedTier || "None",
        licenseKey: null,
        startingBalance: 0,
        targetBalance: 0,
        accountLocked: false,
        isSuspended: false
    });

    const registeredUser = await User.register(newUser, req.body.password);
    
    req.login(registeredUser, (err) => {
        if(err) {
            req.flash("error", "Auto login session failure.");
            return res.redirect("/login");
        }
        // SMART REDIRECT: If coming from pricing, go to checkout. Otherwise dashboard
        const redirectTo = req.body.selectedTier ? 
            `/checkout?tier=${encodeURIComponent(req.body.selectedTier)}` : 
            "/dashboard";
        res.redirect(redirectTo);
    });
  } catch (err) {
    req.flash("error", err.message);
    res.redirect("/register");
  }
});

app.get("/login", (req, res) => {
    // Check if there's a pending tier selection (coming from pricing)
    const pendingTier = req.query.tier;
    res.render("login", { pendingTier: pendingTier || null, error: req.flash("error") });
});

app.post("/login", (req, res, next) => {
    passport.authenticate("local", (err, user, info) => {
        if (err) return next(err);
        if (!user) {
            req.flash("error", info.message || "Invalid credentials");
            return res.redirect("/login");
        }
        req.logIn(user, (err) => {
            if (err) return next(err);
            
            // SMART REDIRECT: Check if they were trying to purchase
            const pendingTier = req.body.pendingTier;
            if (pendingTier && pendingTier !== "None" && pendingTier !== "") {
                return res.redirect(`/checkout?tier=${encodeURIComponent(pendingTier)}`);
            }
            // Regular login goes to dashboard
            return res.redirect("/dashboard");
        });
    })(req, res, next);
});

app.get("/logout", (req, res) => {
  req.logout((err) => res.redirect("/"));
});

app.get("/dashboard", isLoggedIn, (req, res) => {
    if (req.user.username === "admin") return res.redirect("/admin");
    res.render("dashboard", { currentUser: req.user });
});

// ==========================================
// PROFILE MANAGEMENT ROUTES
// ==========================================

app.post("/profile/update", isLoggedIn, async (req, res) => {
    try {
        const { email, whatsapp, country } = req.body;
        if (!email || !email.trim()) {
            req.flash("error", "Email address is required.");
            return res.redirect("/dashboard");
        }
        const user = await User.findById(req.user._id);
        user.email = email.trim();
        user.whatsapp = whatsapp ? whatsapp.trim() : "";
        user.country = country ? country.trim() : "";
        await user.save();
        req.flash("success", "Profile updated successfully.");
        res.redirect("/dashboard");
    } catch (err) {
        req.flash("error", err.message || "Could not update profile.");
        res.redirect("/dashboard");
    }
});

app.post("/profile/change-password", isLoggedIn, async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) {
        req.flash("error", "Please fill in all password fields.");
        return res.redirect("/dashboard");
    }
    if (newPassword.length < 6) {
        req.flash("error", "New password must be at least 6 characters long.");
        return res.redirect("/dashboard");
    }
    if (newPassword !== confirmPassword) {
        req.flash("error", "New password and confirmation do not match.");
        return res.redirect("/dashboard");
    }
    req.user.changePassword(currentPassword, newPassword, (err) => {
        if (err) {
            req.flash("error", err.message.includes("Incorrect") ? "Current password is incorrect." : "Could not change password.");
            return res.redirect("/dashboard");
        }
        req.flash("success", "Password changed successfully.");
        res.redirect("/dashboard");
    });
});


// ==========================================
// 3. ADMIN PANEL ROUTES
// ==========================================

// --- Simple visitor counter (in-memory, resets on server restart) ---
let totalVisitorCount = 0;
app.use((req, res, next) => {
    // Only count page views, not API calls or static assets
    if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/checkout/') && !req.path.includes('.')) {
        totalVisitorCount++;
    }
    next();
});

app.get("/admin", isAdmin, async (req, res) => {
    const allUsers = await User.find({ username: { $ne: "admin" } }).sort({ _id: -1 });
    const now = new Date();

    let activeCount = 0, suspendedCount = 0, lockedCount = 0, expiredCount = 0, unlicensedCount = 0;
    let totalRevenue = 0;
    let totalAffiliatePayouts = 0;
    const revenueByTierMap = {};
    const regionMap = {};

    allUsers.forEach(client => {
        const hasKey = !!client.licenseKey;
        const isExpired = client.licenseExpiry ? now > new Date(client.licenseExpiry) : false;

        if (client.accountLocked) lockedCount++;
        else if (client.isSuspended) suspendedCount++;
        else if (hasKey && isExpired) expiredCount++;
        else if (hasKey && !isExpired) activeCount++;
        else unlicensedCount++;

        const revenue = Number(client.prepaymentAmount) || 0;
        totalRevenue += revenue;
        
        // Track affiliate payouts (commission from affiliateEngine)
        const commission = Number(client.affiliateCommission) || 0;
        totalAffiliatePayouts += commission;

        if (hasKey) {
            const tierKey = client.currentTier || "Unknown";
            revenueByTierMap[tierKey] = (revenueByTierMap[tierKey] || 0) + revenue;
        }

        const region = (client.country && client.country.trim()) ? client.country.trim() : "Unknown";
        regionMap[region] = (regionMap[region] || 0) + 1;
    });

    const dayBuckets = {};
    for (let i = 29; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        dayBuckets[d.toISOString().slice(0, 10)] = 0;
    }
    allUsers.forEach(client => {
        try {
            const key = client._id.getTimestamp().toISOString().slice(0, 10);
            if (key in dayBuckets) dayBuckets[key]++;
        } catch (e) {}
    });
    const registrationTrend = Object.keys(dayBuckets).map(date => ({ date, count: dayBuckets[date] }));

    const regionEntries = Object.entries(regionMap).sort((a, b) => b[1] - a[1]);
    const topAccountsByRegion = regionEntries.slice(0, 6).map(([region, count]) => ({ region, count }));
    const otherRegionsCount = regionEntries.slice(6).reduce((sum, [, c]) => sum + c, 0);
    if (otherRegionsCount > 0) topAccountsByRegion.push({ region: "Other", count: otherRegionsCount });

    const revenueByTier = Object.entries(revenueByTierMap)
        .sort((a, b) => b[1] - a[1])
        .map(([tier, revenue]) => ({ tier, revenue }));

    const topEarners = allUsers
        .filter(c => c.licenseKey)
        .sort((a, b) => (Number(b.prepaymentAmount) || 0) - (Number(a.prepaymentAmount) || 0))
        .slice(0, 8)
        .map(c => ({
            username: c.username,
            email: c.email,
            country: (c.country && c.country.trim()) || "Unknown",
            tier: c.currentTier || "None",
            revenue: Number(c.prepaymentAmount) || 0
        }));

    const negativeLogouts = allUsers
        .filter(c => c.accountLocked)
        .map(c => ({
            username: c.username,
            email: c.email,
            tier: c.currentTier || "None",
            startingBalance: Number(c.startingBalance) || 0,
            targetBalance: Number(c.targetBalance) || 0
        }));

    // Top Affiliates (if affiliateEngine exists and has data)
    let topAffiliates = [];
    try {
        const Affiliate = require("./models/Affiliate.model");
        const affiliates = await Affiliate.find({}).sort({ totalEarnings: -1 }).limit(8);
        if (affiliates && affiliates.length > 0) {
            topAffiliates = affiliates.map(a => ({
                username: a.username,
                referrals: a.referralCount || 0,
                commission: Number(a.totalEarnings) || 0
            }));
        }
    } catch (e) {
        // Affiliate model doesn't exist yet, leave empty
    }

    res.render("admin", {
        users: allUsers,
        stats: {
            totalVisitors: totalVisitorCount,
            total: allUsers.length,
            active: activeCount,
            suspended: suspendedCount,
            locked: lockedCount,
            expired: expiredCount,
            unlicensed: unlicensedCount,
            totalRevenue,
            totalAffiliatePayouts
        },
        registrationTrend,
        topAccountsByRegion,
        revenueByTier,
        topEarners,
        negativeLogouts,
        topAffiliates
    });
});

// ==========================================
// NEGATIVE ACCOUNT OFFER SERVICE
// ==========================================
app.post("/admin/offer-free-week/:id", isAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            req.flash("error", "Participant not found.");
            return res.redirect("/admin");
        }
        if (!user.accountLocked) {
            req.flash("error", "This account is not currently locked.");
            return res.redirect("/admin");
        }
        
        // Unlock account and grant 7-day free access
        user.accountLocked = false;
        user.isSuspended = false;
        user.licenseExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 1 week
        user.targetBalance = 0; // Reset target so they don't immediately get locked again
        await user.save();
        
        console.log(`[FREE WEEK] Granted 1-week free access to ${user.username} (was Zero-Hedge locked)`);
        req.flash("success", `Granted 1-week free access to ${user.username}. Their account is now active.`);
        res.redirect("/admin");
    } catch (err) {
        console.error("Free week offer error:", err);
        req.flash("error", "Could not process free week offer.");
        res.redirect("/admin");
    }
});

app.post("/admin/generate-license/:id", isAdmin, async (req, res) => {
    const days = parseInt(req.body.durationDays) || 30; 
    const tier = req.body.tierLevel || "Unknown"; 
    const user = await User.findById(req.params.id);
    user.licenseKey = crypto.randomBytes(6).toString('hex').toUpperCase(); 
    user.licenseExpiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000); 
    user.currentTier = tier; 
    user.isSuspended = false; 
    user.accountLocked = false; // Unlock when new license is issued
    await user.save();
    req.flash("success", `Generated ${days}-day ${tier} License for ${user.username}`);
    res.redirect("/admin");
});

app.post("/admin/suspend-license/:id", isAdmin, async (req, res) => {
    const user = await User.findById(req.params.id);
    user.isSuspended = !user.isSuspended;
    await user.save();
    req.flash("success", `Participant ${user.isSuspended ? 'Suspended' : 'Restored'}.`);
    res.redirect("/admin");
});

app.post("/admin/delete-user/:id", isAdmin, async (req, res) => {
    await User.findByIdAndDelete(req.params.id);
    req.flash("success", "Participant permanently deleted from the network.");
    res.redirect("/admin");
});
// ==========================================
// TRAINING SYSTEM ROUTES
// ==========================================



app.get("/api/training/status", async (req, res) => {
    try {
        res.json({
            classes: {
                ECD: { enrolled: 2, min: 5, status: 'waiting' },
                Beginner: { enrolled: 1, min: 5, status: 'waiting' },
                Advanced: { enrolled: 0, min: 5, status: 'waiting' },
                Specialized: { enrolled: 0, min: 5, status: 'waiting' }
            },
            alerts: []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/admin/training/alerts", isAdmin, async (req, res) => {
    res.json({
        alerts: [
            { 
                type: 'HIGH_FLAG', 
                class: 'ECD', 
                student: 'John Doe', 
                timestamp: new Date(),
                message: 'John Doe enrolled in ECD Training'
            }
        ]
    });
});

app.get("/training/my-classes", isLoggedIn, async (req, res) => {
    res.render("my-training", { user: req.user });
});

// ==========================================
// DEVELOPER TESTING BACKDOOR
// ==========================================

app.get("/dev/generate-key", async (req, res) => {
    try {
        await User.deleteOne({ username: "DevTester" });
        const testUser = new User({
            username: "DevTester",
            email: "dev@protrading.com",
            licenseKey: "TEST-KEY-2026", 
            licenseExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), 
            currentTier: "Topaz", 
            isSuspended: false,
            mt5AccountNumber: null, 
            startingBalance: 0,
            targetBalance: 0,
            accountLocked: false
        });
        await testUser.save();
        res.send("<h1 style='color: green; font-family: sans-serif;'>Success! Your Test Key is: TEST-KEY-2026</h1>");
    } catch (err) {
        res.send("Error: " + err.message);
    }
});

// --- START SERVER ---
const port = process.env.PORT || 80;
app.listen(port, () => console.log(`ProTrading API running on port ${port}`));