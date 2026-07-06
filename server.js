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

// --- DATABASE CONNECTION (Legacy String to bypass ISP block) ---
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

// ==========================================
// 1. S.M.A.R.T. ENGINE API ROUTES (MT5 <-> Node.js)
// ==========================================

// A. Master EA Endpoint (Receives the master trades & UI State)
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

// C. S.M.A.R.T CLIENT SYNC ENDPOINT (The single connection for the Client EA)
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
    { name: "Amber", range: "$0 to $49", rate: "No Trading", amount: "N/A", color: "text-secondary" },
    { name: "Amethyst", range: "$50 to $199", rate: "$1 Per Day", amount: "$30", color: "text-primary" },
    { name: "Topaz", range: "$200 to $1,000", rate: "11% Per 30 Days", amount: "$22 to $111", color: "text-info" },
    { name: "Tanzanite", range: "$1,000 to $10,000", rate: "10% Per 30 Days", amount: "$100 to $1,000", color: "text-success" },
    { name: "Sapphire", range: "$10,001 to $100K", rate: "9% Per 7 Months", amount: "$900 to $9,000", color: "text-primary" },
    { name: "Emerald", range: "$100K to $1M", rate: "8% Per 7 Months", amount: "$8,000 to $80K", color: "text-success" },
    { name: "Diamond", range: "$1M to $10M", rate: "7% Per 7 Months", amount: "$70K to $700K", color: "text-info" },
    { name: "Rhodium", range: "$10M to $100M", rate: "5% Per 12 Months", amount: "$500K to $5M", color: "text-warning" },
    { name: "Platinum", range: "$100M to $1B", rate: "4% Per 12 Months", amount: "$4M to $40M", color: "text-secondary" },
    { name: "Uranium", range: "$1B to $10B", rate: "3% Per 12 Months", amount: "$30M to $300M", color: "text-success" },
    { name: "Atomic", range: "$10B to $100B", rate: "2% Per 12 Months", amount: "$200M to $2B", color: "text-danger" },
    { name: "Nuclear", range: "$100B to $1T", rate: "1% Per 12 Months", amount: "$1B to $10B", color: "text-warning" },
    { name: "Solomonic", range: "$1T+", rate: "0.5% Per 12 Months", amount: "$5B+", color: "text-warning" }
];

// --- PRICING PAGE ROUTE ---
app.get("/pricing", (req, res) => {
    res.render("pricing", { tiers: pricingTiers });
});

// ==========================================
// PAYNOW INTEGRATION & THE INTELLIGENT CHECKOUT
// ==========================================

const paynow = new Paynow(process.env.PAYNOW_INTEGRATION_ID || "YOUR_INTEGRATION_ID", process.env.PAYNOW_INTEGRATION_KEY || "YOUR_INTEGRATION_KEY");

const LIVE_DOMAIN = "https://bot-proj-2-1.onrender.com";
paynow.resultUrl = `${LIVE_DOMAIN}/api/paynow/update`; 
paynow.returnUrl = `${LIVE_DOMAIN}/checkout/return`; 

const tierConfig = {
    "Amethyst": { price: 30, durationDays: 30 },
    "Topaz": { price: 22, durationDays: 30 },
    "Tanzanite": { price: 100, durationDays: 30 },
    "Sapphire": { price: 900, durationDays: 210 }, 
    "Emerald": { price: 8000, durationDays: 210 },
    "Diamond": { price: 70000, durationDays: 210 },
    "Rhodium": { price: 500000, durationDays: 365 }, 
    "Platinum": { price: 4000000, durationDays: 365 },
    "Uranium": { price: 30000000, durationDays: 365 },
    "Atomic": { price: 200000000, durationDays: 365 },
    "Nuclear": { price: 1000000000, durationDays: 365 },
    "Solomonic": { price: 5000000000, durationDays: 365 }
};

// 1. Intercept users coming from Pricing Page Modal
app.post("/checkout/initialize", (req, res) => {
    const selectedTier = req.body.selectedTier;
    // SEQUENCE FIX: If already logged in, skip registration, go straight to secure checkout portal
    if (req.isAuthenticated()) {
        return res.redirect(`/checkout?tier=${encodeURIComponent(selectedTier)}`);
    }
    // Else, send to Registration Form (it will forward them to checkout after)
    res.render("register", { error: null, selectedTier: selectedTier });
});

// 2. The New Secure Payment Portal (EcoCash UI + Visa Fallback)
app.get("/checkout", isLoggedIn, (req, res) => {
    const tier = req.query.tier;
    if(!tierConfig[tier]) return res.redirect("/pricing");
    res.render("checkout", { tier: tier, config: tierConfig[tier] });
});

// 3. API: Trigger EcoCash/OneMoney USSD Push to User's Phone
app.post("/api/checkout/mobile-push", isLoggedIn, async (req, res) => {
    const { tier, phone, method } = req.body;
    const config = tierConfig[tier];
    if(!config) return res.json({ success: false, error: "Invalid tier" });

    const invoiceRef = `${req.user._id}-${tier}-${Date.now()}`;
    let payment = paynow.createPayment(invoiceRef, req.user.email);
    payment.add(`${tier} Grade D.E.T Activation`, config.price);

    try {
        const response = await paynow.sendMobile(payment, phone, method); // 'ecocash' or 'onemoney'
        if(response.success) {
            res.json({ success: true, instructions: response.instructions });
        } else {
            res.json({ success: false, error: response.error });
        }
    } catch(err) {
        res.json({ success: false, error: "Bank gateway unreachable." });
    }
});

// 4. API: Fallback to standard Paynow Gateway (For Visa/InnBucks)
app.get("/checkout/standard-gateway", isLoggedIn, async (req, res) => {
    const tier = req.query.tier;
    const config = tierConfig[tier];
    const invoiceRef = `${req.user._id}-${tier}-${Date.now()}`;
    let payment = paynow.createPayment(invoiceRef, req.user.email);
    payment.add(`${tier} Grade D.E.T Activation`, config.price);

    try {
        const response = await paynow.send(payment);
        if(response.success) res.redirect(response.redirectUrl);
        else res.redirect("/pricing");
    } catch(e) { res.redirect("/pricing"); }
});

app.get("/checkout/return", isLoggedIn, (req, res) => {
    req.flash("success", "Payment processing! Your 9-Digit ID will generate automatically once the network confirms receipt.");
    res.redirect("/dashboard");
});

// 5. The Silent Webhook
app.post("/api/paynow/update", async (req, res) => {
    const { reference, status } = req.body;
    
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
                user.prepaymentAmount = config.price;
                user.termsAgreed = true;
                user.isSuspended = false; 
                user.accountLocked = false;
                user.mt5AccountNumber = null; 
                
                await user.save();
                console.log(`[SUCCESS] Webhook Verified! 9-Digit ID generated for ${user.username} (${tierName})`);
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
        licenseKey: null, // Key stays null until payment webhook confirms success
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
        // SEQUENCE FIX: Redirect user straight to live paynow checkout portal
        res.redirect(`/checkout?tier=${encodeURIComponent(req.body.selectedTier || "None")}`);
    });
  } catch (err) {
    req.flash("error", err.message);
    res.redirect("/register");
  }
});

app.get("/login", (req, res) => res.render("login"));
app.post("/login", passport.authenticate("local", {
  successRedirect: "/dashboard", failureRedirect: "/login", failureFlash: true
}));

app.get("/logout", (req, res) => {
  req.logout((err) => res.redirect("/"));
});

app.get("/dashboard", isLoggedIn, (req, res) => {
    if (req.user.username === "admin") return res.redirect("/admin");
    res.render("dashboard", { currentUser: req.user });
});


// ==========================================
// 3. ADMIN PANEL ROUTES
// ==========================================
app.get("/admin", isAdmin, async (req, res) => {
    const allUsers = await User.find({ username: { $ne: "admin" } });
    res.render("admin", { users: allUsers });
});

app.post("/admin/generate-license/:id", isAdmin, async (req, res) => {
    const days = parseInt(req.body.durationDays) || 30; 
    const tier = req.body.tierLevel || "Unknown"; 
    
    const user = await User.findById(req.params.id);
    user.licenseKey = crypto.randomBytes(6).toString('hex').toUpperCase(); 
    user.licenseExpiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000); 
    user.currentTier = tier; 
    user.isSuspended = false; 
    
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