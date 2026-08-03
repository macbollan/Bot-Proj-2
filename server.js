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
const nodemailer = require("nodemailer"); 
const Affiliate = require("./models/Affiliate.model");

require("dotenv").config();

const User = require("./models/User.model");
const app = express();

const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'nyctech002@gmail.com',
        pass: 'wcibyjqymgbyonxt'
    }
});

// ==========================================
// PAYMENT CONFIRMATION EMAILS
// ==========================================
// Lightweight sanity check — not full RFC 5322, just enough to catch
// missing/garbled addresses before we waste a send attempt on them.
function isValidEmail(email) {
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Sends the D.E.T activation code after a tier payment is confirmed.
// Never throws — a bad/missing address or an SMTP failure is logged and
// swallowed here so it can never break the webhook response or roll back
// the license that was already saved.
async function sendActivationEmail(user, tierName) {
    if (!isValidEmail(user.email)) {
        console.error(`[EMAIL] Skipped activation email for "${user.username}" — invalid or missing address: "${user.email}"`);
        return false;
    }
    try {
        await emailTransporter.sendMail({
            from: '"D.E.T System" <nyctech002@gmail.com>',
            to: user.email,
            subject: `Your D.E.T ${tierName} Activation is Confirmed`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #1a1818; color: #fff; padding: 30px; border-radius: 12px;">
                    <h2 style="color: #B0BF96; margin-bottom: 20px;">D.E.T System</h2>
                    <p>Hi <strong>${user.username}</strong>, your payment has been confirmed and your <strong>${tierName}</strong> account is now active.</p>
                    <p>Your unique 9-Digit D.E.T ID / license code is:</p>
                    <div style="background: #322C2C; border: 1px solid rgba(176,191,150,0.25); border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
                        <h1 style="font-size: 32px; letter-spacing: 6px; color: #B0BF96; margin: 0;">${user.licenseKey}</h1>
                    </div>
                    <p style="font-size: 13px; color: #94a3b8;">This code is tied to your account and expires on <strong>${user.licenseExpiry.toDateString()}</strong>.</p>
                    <p style="font-size: 13px; color: #94a3b8;">Log in to your dashboard to connect your MT5 terminal and get started.</p>
                    <hr style="border-color: rgba(255,255,255,0.1); margin: 20px 0;">
                    <p style="font-size: 11px; color: #64748b;">D.E.T System &copy; 2026</p>
                </div>
            `
        });
        console.log(`[EMAIL] Activation email sent to ${user.email}`);
        return true;
    } catch (emailErr) {
        console.error(`[EMAIL] Failed to send activation email to "${user.email}":`, emailErr.message);
        return false;
    }
}

// Sends a training enrollment confirmation after a training payment is confirmed.
// Same guarantee as above: failures are caught and logged, never thrown.
async function sendTrainingConfirmationEmail(enrollment) {
    if (!isValidEmail(enrollment.email)) {
        console.error(`[EMAIL] Skipped training confirmation for "${enrollment.studentName}" — invalid or missing address: "${enrollment.email}"`);
        return false;
    }
    try {
        await emailTransporter.sendMail({
            from: '"D.E.T System" <nyctech002@gmail.com>',
            to: enrollment.email,
            subject: `Enrollment Confirmed: ${enrollment.courseName}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #1a1818; color: #fff; padding: 30px; border-radius: 12px;">
                    <h2 style="color: #B0BF96; margin-bottom: 20px;">D.E.T System</h2>
                    <p>Hi <strong>${enrollment.studentName}</strong>, your payment has been received and your seat is confirmed.</p>
                    <div style="background: #322C2C; border: 1px solid rgba(176,191,150,0.25); border-radius: 8px; padding: 20px; margin: 20px 0;">
                        <p style="margin: 4px 0;"><strong>Course:</strong> ${enrollment.courseName}</p>
                        <p style="margin: 4px 0;"><strong>Format:</strong> ${enrollment.type === 'one-on-one' ? 'One-on-One' : 'Group'}</p>
                        <p style="margin: 4px 0;"><strong>Amount Paid:</strong> $${enrollment.amountPaid}</p>
                        <p style="margin: 4px 0;"><strong>Reference:</strong> ${enrollment.paynowReference}</p>
                    </div>
                    <p style="font-size: 13px; color: #94a3b8;">Our team will reach out via WhatsApp/email with your session schedule shortly.</p>
                    <hr style="border-color: rgba(255,255,255,0.1); margin: 20px 0;">
                    <p style="font-size: 11px; color: #64748b;">D.E.T System &copy; 2026</p>
                </div>
            `
        });
        console.log(`[EMAIL] Training confirmation sent to ${enrollment.email}`);
        return true;
    } catch (emailErr) {
        console.error(`[EMAIL] Failed to send training confirmation to "${enrollment.email}":`, emailErr.message);
        return false;
    }
}

// ==========================================
// GLOBAL MEMORY FOR D.E.T. DATA
// ==========================================

// A. Master EA Endpoint
// A. Master EA Endpoint (SECURED)
// =========================================
// PER-SYMBOL STATE STORAGE
// =========================================
let eaBrainStates = {}; // Keyed by symbol: { "GBPUSD": {...}, "XAUUSD": {...} }
let activeTradesBySymbol = {}; // Keyed by symbol
let eaBrainState = getDefaultBrainState(); // <-- ADD THIS LINE
let activeTradesList = [];         

// Default state for symbols that haven't received data yet
function getDefaultBrainState() {
    return {
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
}


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



// Enhanced security middleware
function isLoggedIn(req, res, next) {
    if (req.isAuthenticated()) {
        // Check if user is verified
        if (req.user.isVerified) {
            return next();
        }
        // Allow access to verification-related routes
        if (req.path === '/verify-email' || req.path === '/verify-email/resend' || req.path === '/logout') {
            return next();
        }
        req.flash("error", "Please verify your email first.");
        return res.redirect("/verify-email");
    }
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


// 5. The Silent Webhook - handles both D.E.T activations AND training payments
app.post("/api/paynow/update", async (req, res) => {
    const { reference, status, amount } = req.body;
    
    // --- HANDLE TRAINING PAYMENTS ---
    if (reference && reference.startsWith("TRAIN-")) {
        if (status === "Paid" || status === "Awaiting Delivery") {
            try {
                const enrollment = await Training.findOne({ paynowReference: reference });
                if (enrollment && enrollment.status === 'pending_payment') {
                    enrollment.status = 'paid';
                    enrollment.amountPaid = parseFloat(amount) || enrollment.price;
                    enrollment.paidAt = new Date();
                    await enrollment.save();
                    console.log(`[TRAINING] Payment confirmed: ${enrollment.studentName} - ${enrollment.courseName} ($${amount})`);

                    // Send the enrollment confirmation by email. Wrapped internally so a bad
                    // address or SMTP hiccup can never undo the save above or block the ack below.
                    await sendTrainingConfirmationEmail(enrollment);
                }
            } catch (err) {
                console.error("Training webhook error:", err);
            }
        }
        return res.status(200).send("OK");
    }
    
    // --- HANDLE D.E.T ACTIVATION PAYMENTS ---
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
                
                // PROCESS AFFILIATE COMMISSION FOR THIS PAYMENT
                if (user.referredBy) {
                    await processAffiliateCommissionOnPayment(user, parseFloat(amount) || config.min, tierName);
                }
                
                console.log(`[SUCCESS] Webhook Verified! 9-Digit ID generated for ${user.username} (${tierName}) - Paid: $${amount}`);

                // Send the activation code by email. Wrapped internally so a bad
                // address or SMTP hiccup can never undo the save above or block the ack below.
                await sendActivationEmail(user, tierName);
            }
        } catch (err) {
            console.error("Webhook database update failed:", err);
        }
    }
    res.status(200).send("OK");
});
// ==========================================
// 1. S.M.A.R.T. ENGINE API ROUTES (MT5 <-> Node.js)
// ==========================================

app.get("/faqs", (req, res) => {
    res.render("faqs");
});

// A. Master EA Endpoint
// A. Master EA Endpoint (SECURED)
// =========================================
// PER-SYMBOL STATE STORAGE
// =========================================

// A. Master EA Endpoint (SECURED) — Updated for per-symbol storage
app.post("/api/master/update", (req, res) => {
    const { masterPassword, analysis, trades, uiState } = req.body;
    
    const MASTER_SECRET = process.env.MASTER_EA_SECRET || "DET_MASTER_2026_CHANGE_ME";
    if (masterPassword !== MASTER_SECRET) {
        console.log("[SECURITY] Unauthorized master update attempt");
        return res.status(401).json({ status: "unauthorized" });
    }
    
    if (analysis && analysis.symbol) {
        const symbol = analysis.symbol;
        
        // Initialize if first time for this symbol
        if (!eaBrainStates[symbol]) {
            eaBrainStates[symbol] = { ...getDefaultBrainState() };
        }
        
        const state = eaBrainStates[symbol];
        state.symbol = analysis.symbol;
        state.trend = analysis.trend;
        state.action = analysis.action;
        state.price = analysis.price;
        state.openTrades = analysis.openTrades;
        
        if (analysis.equity) {
            state.equityHistory.push(parseFloat(analysis.equity));
            if (state.equityHistory.length > 50) state.equityHistory.shift();
        }
        
        if (uiState) {
            if (uiState.trends) state.trends = uiState.trends;
            if (uiState.analytics) state.analytics = uiState.analytics;
        }
        
        if (trades) activeTradesBySymbol[symbol] = trades;
        
        // Also update legacy eaBrainState for dashboard compatibility
        eaBrainState = { ...state };
        if (trades) activeTradesList = trades;
        
        console.log(`[MASTER UPDATE] ${symbol} | Price: ${analysis.price} | Trades: ${analysis.openTrades}`);
    }
    
    res.json({ status: "success" });
});


// B. Public Endpoint — returns all symbols
app.get("/api/public/ea-state", (req, res) => {
    const symbol = req.query.symbol || eaBrainState.symbol;
    const state = eaBrainStates[symbol] || eaBrainState;
    res.json({
        ...state,
        availableSymbols: Object.keys(eaBrainStates)
    });
});

// C. S.M.A.R.T CLIENT SYNC ENDPOINT
// C. S.M.A.R.T CLIENT SYNC ENDPOINT — Updated with tier info, symbol selection
app.post("/api/client/sync", async (req, res) => {
    const { licenseKey, currentBalance, currentEquity, preferredSymbol } = req.body;
    
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
            user.lockReason = 'target_reached';
            await user.save();
            console.log(`[ZERO-HEDGE] ${user.username} doubled! Locking.`);
            return res.json({ action: "ZERO_HEDGE" });
        }

        if (updated) await user.save();

        // Determine which symbol to send
        const symbol = preferredSymbol || eaBrainState.symbol || "GBPUSD";
        const masterState = eaBrainStates[symbol] || eaBrainState;
        const trades = activeTradesBySymbol[symbol] || activeTradesList;

        res.json({
            action: "TRADE",
            masterState: masterState,
            trades: trades,
            userTier: user.currentTier || "None",
            availableSymbols: Object.keys(eaBrainStates)
        });

    } catch (err) {
        console.error("Sync Error:", err);
        res.status(500).json({ action: "ERROR" });
    }
});



// --- PRICING TIERS DATA ---
const pricingTiers = [
    { name: "Amber", designation: "Promo", float: "$0 to $49", percentage: "$1/Day", period: "Per Month", minSub: "$1", maxSub: "$30" },
    { name: "Amethyst", designation: "Level", float: "$50 to $199", percentage: "12%", period: "Per Month", minSub: "$6", maxSub: "$24" },
    { name: "Topaz", designation: "Level", float: "$200 to $1,000", percentage: "11%", period: "Per 2 Months", minSub: "$22", maxSub: "$111" },
    { name: "Tanzanite", designation: "Level", float: "$1,000 to $10,000", percentage: "10%", period: "Per 3 Months", minSub: "$100", maxSub: "$1,000" },
    { name: "Sapphire", designation: "Level", float: "$10,001 to $100K", percentage: "9%", period: "Per 4 Months", minSub: "$900", maxSub: "$9,000" },
    { name: "Emerald", designation: "Level", float: "$100K to $1M", percentage: "8%", period: "Per 5 Months", minSub: "$8,000", maxSub: "$80K" },
    { name: "Diamond", designation: "Level", float: "$1M to $10M", percentage: "7%", period: "Per 7 Months", minSub: "$70K", maxSub: "$700K" },
    { name: "Rhodium", designation: "Grade", float: "$10M to $100M", percentage: "5%", period: "Per 1 Year", minSub: "$500K", maxSub: "$5M" },
    { name: "Platinum", designation: "Grade", float: "$100M to $1B", percentage: "4%", period: "Per 2 Years", minSub: "$4M", maxSub: "$40M" },
    { name: "Uranium", designation: "Grade", float: "$1B to $10B", percentage: "3%", period: "Per 3 Years", minSub: "$30M", maxSub: "$300M" },
    { name: "Atomic", designation: "Grade", float: "$10B to $100B", percentage: "2%", period: "Per 4 Years", minSub: "$200M", maxSub: "$2B" },
    { name: "Nuclear", designation: "Grade", float: "$100B to $1T", percentage: "1%", period: "Per 5 Years", minSub: "$1B", maxSub: "$10B" },
    { name: "Solomonic", designation: "Grade", float: "$1T+", percentage: "0.5%", period: "Per 7 Years", minSub: "$5B", maxSub: "No Limit" }
];

// --- PRICING PAGE ROUTE ---
app.get("/pricing", (req, res) => {
    res.render("pricing", { tiers: pricingTiers });
});

// --- NAVIGATION ROUTES ---
app.get("/training", (req, res) => {
    res.render("training");
});

// ==========================================
// PAYNOW INTEGRATION & DYNAMIC CHECKOUT
// ==========================================

const paynow = new Paynow(
    process.env.PAYNOW_INTEGRATION_ID || "21038", 
    process.env.PAYNOW_INTEGRATION_KEY || "b5bd8cc5-4797-4435-961e-7bb7e93e2cc8"
);

const LIVE_DOMAIN = "https://bot-proj-2-1.onrender.com";
paynow.resultUrl = `${LIVE_DOMAIN}/api/paynow/update`; 
paynow.returnUrl = `${LIVE_DOMAIN}/checkout/return`; 

// DYNAMIC TIER CONFIG WITH MIN/MAX RANGES
const tierConfig = {
    "Amber": { min: 1, max: 30, durationDays: 30 },
    "Amethyst": { min: 6, max: 24, durationDays: 30 },
    "Topaz": { min: 22, max: 111, durationDays: 60 },
    "Tanzanite": { min: 100, max: 1000, durationDays: 90 },
    "Sapphire": { min: 900, max: 9000, durationDays: 120 }, 
    "Emerald": { min: 8000, max: 80000, durationDays: 150 },
    "Diamond": { min: 70000, max: 700000, durationDays: 210 },
    "Rhodium": { min: 500000, max: 5000000, durationDays: 365 }, 
    "Platinum": { min: 4000000, max: 40000000, durationDays: 730 },
    "Uranium": { min: 30000000, max: 300000000, durationDays: 1095 },
    "Atomic": { min: 200000000, max: 2000000000, durationDays: 1460 },
    "Nuclear": { min: 1000000000, max: 10000000000, durationDays: 1825 },
    "Solomonic": { min: 5000000000, max: 999999999999, durationDays: 2555 }
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
    if(!tierConfig[tier]) {
        req.flash("error", "Invalid tier selected.");
        return res.redirect("/pricing");
    }
    
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
        req.flash("error", "Invalid payment amount for this tier.");
        return res.redirect("/pricing");
    }

    const invoiceRef = `${req.user._id}-${tier}-${Date.now()}`;
    let payment = paynow.createPayment(invoiceRef, req.user.email);
    payment.add(`${tier} Grade D.E.T Activation`, amount);

    try {
        const response = await paynow.send(payment);
        if(response.success) {
            res.redirect(response.redirectUrl);
        } else {
            req.flash("error", "Payment initiation failed. Please try again.");
            res.redirect("/pricing");
        }
    } catch(e) {
        req.flash("error", "Payment gateway error. Please try again.");
        res.redirect("/pricing");
    }
});

app.get("/checkout/return", isLoggedIn, (req, res) => {
    req.flash("success", "Payment processing! Your 9-Digit ID will generate automatically once network confirms.");
    res.redirect("/dashboard");
});

// NOTE: a second app.post("/api/paynow/update", ...) used to live here.
// Express matches routes in registration order and the earlier handler
// (above, near the top of the file) always sent a response first, so this
// one could never actually run — it was dead code. Its activation logic
// has been merged into the reachable handler above; nothing here was lost.

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


app.get("/register", (req, res) => {
    const referralCode = req.query.ref || '';
    const redirect = req.query.redirect || '';
    const selectedTier = req.query.tier || null;
    res.render("register", { 
        selectedTier: selectedTier,
        referralCode: referralCode,
        redirect: redirect
    });
});



app.post("/register", async (req, res) => {
  let redirectUrl = "/register";
  const params = new URLSearchParams();

  try {
    const referralCode = req.body.ref || req.query.ref || null;
    const emailToCheck = req.body.email ? req.body.email.toLowerCase().trim() : "";

    if (referralCode) params.append('ref', referralCode);
    if (req.body.redirect) params.append('redirect', req.body.redirect);
    if (req.body.selectedTier && req.body.selectedTier !== 'None') params.append('tier', req.body.selectedTier);
    const queryString = params.toString();
    if (queryString) redirectUrl += `?${queryString}`;

    // 1. EXPLICIT EMAIL CHECK
    if (emailToCheck) {
        const existingEmail = await User.findOne({ email: new RegExp('^' + emailToCheck + '$', 'i') });
        if (existingEmail) {
            req.flash("error", "An account with that email address already exists.");
            return req.session.save(() => res.redirect(redirectUrl));
        }
    }
    
    // Generate verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    
    const newUser = new User({ 
        username: req.body.username, 
        email: emailToCheck,
        whatsapp: req.body.whatsapp || "",
        country: req.body.country || "",
        currentTier: req.body.selectedTier || "None",
        licenseKey: null,
        startingBalance: 0,
        targetBalance: 0,
        accountLocked: false,
        isSuspended: false,
        referredBy: referralCode,
        // NEW: Verification fields
        isVerified: false,
        verificationCode: verificationCode,
        verificationCodeExpires: Date.now() + 30 * 60 * 1000 // 30 minutes
    });

    // 2. PASSPORT REGISTRATION
    const registeredUser = await User.register(newUser, req.body.password);
    
    // 3. SEND VERIFICATION EMAIL - WAIT FOR IT TO COMPLETE
    let emailSent = false;
    try {
        await emailTransporter.sendMail({
            from: '"D.E.T System" <nyctech002@gmail.com>',
            to: registeredUser.email,
            subject: 'Verify Your D.E.T Account - Action Required',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #1a1818; color: #fff; padding: 30px; border-radius: 12px;">
                    <h2 style="color: #B0BF96; margin-bottom: 20px;">Verify Your D.E.T Account</h2>
                    <p>Hi <strong>${registeredUser.username}</strong>, welcome to D.E.T System!</p>
                    <p>Your verification code is:</p>
                    <div style="background: #322C2C; border: 1px solid rgba(176,191,150,0.25); border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
                        <h1 style="font-size: 36px; letter-spacing: 8px; color: #B0BF96; margin: 0;">${verificationCode}</h1>
                    </div>
                    <p style="font-size: 13px; color: #94a3b8;">This code expires in <strong>30 minutes</strong>.</p>
                    <p style="font-size: 13px; color: #94a3b8;">Enter this code on the verification page to activate your account.</p>
                    <hr style="border-color: rgba(255,255,255,0.1); margin: 20px 0;">
                    <p style="font-size: 11px; color: #64748b;">If you didn't create this account, please ignore this email.</p>
                    <p style="font-size: 11px; color: #64748b;">D.E.T System &copy; 2026</p>
                </div>
            `
        });
        emailSent = true;
        console.log(`[VERIFICATION] Code sent to ${registeredUser.email}: ${verificationCode}`);
    } catch (emailErr) {
        console.error("Verification email failed:", emailErr);
        // Still log the code so user can be helped manually
        console.log(`[VERIFICATION] Code for ${registeredUser.email} (email failed): ${verificationCode}`);
    }
    
    // 4. AFFILIATE TRACKING LOGIC
    if (referralCode) {
        try {
            const Affiliate = require("./models/Affiliate.model");
            const affiliate = await Affiliate.findOne({ referralCode: referralCode });
            if (affiliate) {
                const alreadyTracked = affiliate.referrals.some(r => r.userId && r.userId.toString() === registeredUser._id.toString());
                if (!alreadyTracked) {
                    affiliate.referrals.push({
                        userId: registeredUser._id, username: registeredUser.username, email: registeredUser.email,
                        tier: 'Pending', amountPaid: 0, commissionEarned: 0, status: 'pending', referredAt: new Date()
                    });
                    affiliate.totalReferrals += 1;
                    await affiliate.save();
                }
            }
        } catch (trackErr) { console.error("Referral tracking error:", trackErr); }
    }
    
    // 5. AUTO LOGIN - After email is sent
    req.login(registeredUser, (err) => {
        if(err) {
            req.flash("error", "Account created, but auto-login failed. Please login manually.");
            return req.session.save(() => res.redirect("/login"));
        }
        
        if (emailSent) {
            req.flash("success", "Account created! Please check your email for the verification code.");
        } else {
            req.flash("success", "Account created! Click 'Resend Code' if you don't receive the verification email within a few minutes.");
        }
        
        // Store pending tier in session for after verification
        if (req.body.selectedTier && req.body.selectedTier !== 'None') {
            req.session.pendingTier = req.body.selectedTier;
        }
        
        // Save session before redirect
        req.session.save(() => {
            res.redirect("/verify-email");
        });
    });

  } catch (err) {
    console.error("Registration Error:", err);
    
    let errorMessage = "Registration failed. Please check your details and try again.";
    
    if (err.name === 'UserExistsError') {
        errorMessage = "That username is already taken. Please choose another one.";
    } 
    else if (err.code === 11000) {
        if (err.message && err.message.includes('email')) {
            errorMessage = "An account with that email address already exists.";
        } else {
            errorMessage = "A duplicate record was found. Please check your details.";
        }
    } 
    else if (err.name === 'ValidationError') {
        errorMessage = err.message;
    }
    else if (err.message) {
        errorMessage = err.message;
    }

    req.flash("error", errorMessage);
    req.session.save(() => {
        res.redirect(redirectUrl);
    });
  }
});


// --- VERIFICATION PAGE ---
app.get("/verify-email", isLoggedIn, (req, res) => {
    // If already verified, redirect to dashboard
    if (req.user.isVerified) {
        req.flash("success", "Your account is already verified.");
        return res.redirect("/dashboard");
    }
    res.render("verify-email", { currentUser: req.user });
});

// --- VERIFY CODE ---
app.post("/verify-email", isLoggedIn, async (req, res) => {
    const { code } = req.body;
    
    try {
        const user = await User.findById(req.user._id);
        
        if (!user) {
            req.flash("error", "User not found.");
            return res.redirect("/login");
        }
        
        if (user.isVerified) {
            req.flash("success", "Account already verified.");
            return res.redirect("/dashboard");
        }
        
        // Check if code has expired
        if (user.verificationCodeExpires < Date.now()) {
            req.flash("error", "Verification code has expired. Please request a new one.");
            return res.redirect("/verify-email");
        }
        
        // Check code
        if (user.verificationCode !== code) {
            req.flash("error", "Invalid verification code. Please try again.");
            return res.redirect("/verify-email");
        }
        
        // Verify the user
        user.isVerified = true;
        user.verificationCode = undefined;
        user.verificationCodeExpires = undefined;
        await user.save();
        
        req.flash("success", "Email verified successfully! Welcome to D.E.T System.");
        
        // Redirect to checkout if user was signing up for a tier
        const redirectTo = req.session.pendingTier ? 
            `/checkout?tier=${encodeURIComponent(req.session.pendingTier)}` : 
            "/dashboard";
        
        delete req.session.pendingTier;
        res.redirect(redirectTo);
        
    } catch (err) {
        console.error("Verification error:", err);
        req.flash("error", "Could not verify email. Please try again.");
        res.redirect("/verify-email");
    }
});

// --- RESEND VERIFICATION CODE ---
app.post("/verify-email/resend", isLoggedIn, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        
        if (user.isVerified) {
            req.flash("success", "Account already verified.");
            return res.redirect("/dashboard");
        }
        
        // Generate new code
        const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
        user.verificationCode = verificationCode;
        user.verificationCodeExpires = Date.now() + 30 * 60 * 1000;
        await user.save();
        
        // Send email
        try {
            await emailTransporter.sendMail({
                from: '"D.E.T System" <nyctech002@gmail.com>',
                to: user.email,
                subject: 'New Verification Code - D.E.T System',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #1a1818; color: #fff; padding: 30px; border-radius: 12px;">
                        <h2 style="color: #B0BF96; margin-bottom: 20px;">New Verification Code</h2>
                        <p>Hi <strong>${user.username}</strong>, here's your new verification code:</p>
                        <div style="background: #322C2C; border: 1px solid rgba(176,191,150,0.25); border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
                            <h1 style="font-size: 36px; letter-spacing: 8px; color: #B0BF96; margin: 0;">${verificationCode}</h1>
                        </div>
                        <p style="font-size: 13px; color: #94a3b8;">This code expires in 30 minutes.</p>
                    </div>
                `
            });
            console.log(`[VERIFICATION] New code sent to ${user.email}: ${verificationCode}`);
        } catch (emailErr) {
            console.error("Resend verification email failed:", emailErr);
        }
        
        req.flash("success", "New verification code sent to your email.");
        res.redirect("/verify-email");
        
    } catch (err) {
        console.error("Resend verification error:", err);
        req.flash("error", "Could not resend code.");
        res.redirect("/verify-email");
    }
});



// --- HOW IT WORKS PAGE ---
app.get("/how-it-works", (req, res) => {
    res.render("how-it-works");
});


// ==========================================
// FORGOT PASSWORD ROUTES
// ==========================================

// Store reset tokens in memory (in production, use a proper store)
const resetTokens = {};

app.get("/login", (req, res) => {
    const pendingTier = req.query.tier;
    const referralCode = req.query.ref || '';
    const redirect = req.query.redirect || '';
    const course = req.query.course || '';
    const type = req.query.type || 'group';
    const showForgot = req.query.forgot === 'true';
    const showReset = req.query.reset === 'true';
    const resetToken = req.query.token || '';
    const userId = req.query.uid || '';
    
    res.render("login", { 
        pendingTier: pendingTier || null, 
        referralCode: referralCode,
        redirect: redirect,
        course: course,
        type: type,
        showForgot: showForgot,
        showReset: showReset,
        resetToken: resetToken,
        userId: userId
    });
});

// Send reset code
// Send reset code
app.post("/forgot-password", async (req, res) => {
    const { identifier, resetMethod } = req.body;
    
    try {
        const user = await User.findOne({
            $or: [
                { email: identifier },
                { username: identifier }
            ]
        });
        
        if (!user) {
            req.flash("error", "No account found with that email or username.");
            return res.redirect("/login?forgot=true");
        }
        
        if (!user.email || !user.email.includes('@')) {
            req.flash("error", "This account has no valid email address. Contact support.");
            return res.redirect("/login?forgot=true");
        }
        
        // Generate 6-digit code
        const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
        const resetToken = crypto.randomBytes(32).toString('hex');
        
        // Store token (15 minute expiry)
        resetTokens[resetToken] = {
            userId: user._id.toString(),
            code: resetCode,
            expires: Date.now() + 15 * 60 * 1000
        };
        
        // Send via email
        if (resetMethod === 'email') {
            try {
                await emailTransporter.sendMail({
                    from: '"D.E.T System" <nyctech002@gmail.com>',
                    to: user.email,
                    subject: 'D.E.T Password Reset Code',
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #1a1818; color: #fff; padding: 30px; border-radius: 12px;">
                            <h2 style="color: #B0BF96; margin-bottom: 20px;">D.E.T System</h2>
                            <p>You requested a password reset for <strong>${user.username}</strong>.</p>
                            <p>Your reset code is:</p>
                            <div style="background: #322C2C; border: 1px solid rgba(176,191,150,0.25); border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0;">
                                <h1 style="font-size: 36px; letter-spacing: 8px; color: #B0BF96; margin: 0;">${resetCode}</h1>
                            </div>
                            <p style="font-size: 13px; color: #94a3b8;">This code expires in <strong>15 minutes</strong>.</p>
                            <p style="font-size: 13px; color: #94a3b8;">If you didn't request this, please ignore this email.</p>
                            <hr style="border-color: rgba(255,255,255,0.1); margin: 20px 0;">
                            <p style="font-size: 11px; color: #64748b;">D.E.T System &copy; 2026</p>
                        </div>
                    `
                });
                console.log(`[PASSWORD RESET] Email sent to ${user.email} with code: ${resetCode}`);
                req.flash("success", "Reset code sent to your email. Check your inbox.");
            } catch (emailErr) {
                console.error("Email send failed:", emailErr);
                req.flash("error", "Could not send email. Please try again or contact support.");
                return res.redirect("/login?forgot=true");
            }
        } else {
            // WhatsApp method — logs code for now (integrate Twilio/WATI later)
            console.log(`[PASSWORD RESET] WhatsApp code for ${user.username}: ${resetCode}`);
            req.flash("success", "Reset code sent via WhatsApp. Check your phone.");
        }
        
        res.redirect(`/login?reset=true&token=${resetToken}&uid=${user._id}`);
        
    } catch (err) {
        console.error("Forgot password error:", err);
        req.flash("error", "Could not process request. Please try again.");
        res.redirect("/login?forgot=true");
    }
});


// Reset password
app.post("/reset-password", async (req, res) => {
    const { resetToken, userId, resetCode, newPassword, confirmPassword } = req.body;
    
    try {
        const stored = resetTokens[resetToken];
        
        if (!stored || stored.expires < Date.now()) {
            req.flash("error", "Reset code has expired. Please request a new one.");
            return res.redirect("/login?forgot=true");
        }
        
        if (stored.code !== resetCode) {
            req.flash("error", "Invalid reset code. Please try again.");
            return res.redirect(`/login?reset=true&token=${resetToken}&uid=${userId}`);
        }
        
        if (newPassword !== confirmPassword) {
            req.flash("error", "Passwords do not match.");
            return res.redirect(`/login?reset=true&token=${resetToken}&uid=${userId}`);
        }
        
        if (newPassword.length < 8) {
            req.flash("error", "Password must be at least 8 characters.");
            return res.redirect(`/login?reset=true&token=${resetToken}&uid=${userId}`);
        }
        
        const user = await User.findById(userId);
        if (!user) {
            req.flash("error", "User not found.");
            return res.redirect("/login");
        }
        
        await user.setPassword(newPassword);
        await user.save();
        
        // Clean up token
        delete resetTokens[resetToken];
        
        req.flash("success", "Password reset successfully! Please login with your new password.");
        res.redirect("/login");
        
    } catch (err) {
        console.error("Reset password error:", err);
        req.flash("error", "Could not reset password.");
        res.redirect("/login?forgot=true");
    }
});



app.post("/login", (req, res, next) => {
    const loginField = req.body.username.trim();
    
    User.findOne({ email: new RegExp('^' + loginField + '$', 'i') }).then(userByEmail => {
        
        if (userByEmail) {
            req.body.username = userByEmail.username;
        }

        passport.authenticate("local", (err, user, info) => {
            if (err) return next(err);
            if (!user) {
                req.flash("error", "Invalid username/email or password.");
                return req.session.save(() => res.redirect("/login")); 
            }
            
            // NEW: Check if user is verified
            if (!user.isVerified) {
                // Log them in but redirect to verification page
                req.logIn(user, (err) => {
                    if (err) return next(err);
                    req.flash("error", "Please verify your email before accessing your account. If you didn't get the code, please press Resend");
                    return res.redirect("/verify-email");
                });
                return;
            }
            
            req.logIn(user, (err) => {
                if (err) return next(err);
                req.flash("success", `Welcome back, ${user.username}!`);
                handleLoginRedirect(req, res);
            });
        })(req, res, next);
        
    }).catch(err => next(err));
});




function handleLoginRedirect(req, res) {
    const pendingTier = req.body.pendingTier;
    if (pendingTier && pendingTier !== "None" && pendingTier !== "") {
        return res.redirect(`/checkout?tier=${encodeURIComponent(pendingTier)}`);
    }
    const redirect = req.body.redirect;
    if (redirect === 'affiliate') return res.redirect("/affiliate");
    if (redirect === 'training') {
        const course = req.body.course || '';
        const type = req.body.type || 'group';
        if (course) return res.redirect(`/training/enroll/${course}/${type}`);
        return res.redirect("/training");
    }
    return res.redirect("/dashboard");
}

app.get("/logout", (req, res) => {
    req.logout((err) => {
        if (err) {
            console.error("Logout error:", err);
        }
        req.flash("success", "You have been logged out successfully.");
        res.redirect("/");
    });
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
    if (newPassword.length < 8) {
        req.flash("error", "New password must be at least 8 characters long.");
        return res.redirect("/dashboard");
    }
    if (newPassword !== confirmPassword) {
        req.flash("error", "New password and confirmation do not match.");
        return res.redirect("/dashboard");
    }
    
    try {
        // passport-local-mongoose changePassword handles verification internally
        await req.user.changePassword(currentPassword, newPassword);
        req.flash("success", "Password changed successfully.");
    } catch (err) {
        if (err.message && err.message.includes("incorrect")) {
            req.flash("error", "Current password is incorrect.");
        } else {
            req.flash("error", "Could not change password. Please try again.");
            console.error("Password change error:", err);
        }
    }
    
    res.redirect("/dashboard");
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
    

    // Positive Logouts - accounts that hit 100% gain profitably
    const positiveLogouts = allUsers
        .filter(c => c.accountLocked && Number(c.startingBalance) > 0)
        .map(c => ({
            username: c.username,
            email: c.email,
            tier: c.currentTier || "None",
            startingBalance: Number(c.startingBalance) || 0,
            targetBalance: Number(c.targetBalance) || 0,
            profit: (Number(c.targetBalance) || 0) - (Number(c.startingBalance) || 0)
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

    // =========================================
// TOP EARNERS BY TIER (Top 50 per tier)
// =========================================
const tierList = ["Amber", "Amethyst", "Topaz", "Tanzanite", "Sapphire", "Emerald", "Diamond", "Rhodium", "Platinum", "Uranium", "Atomic", "Nuclear", "Solomonic"];

// =========================================
// TOP EARNERS BY TIER (Top 50 per tier)
// =========================================

const topEarnersByTier = {};
tierList.forEach(tierName => {
    topEarnersByTier[tierName] = allUsers
        .filter(c => c.licenseKey && c.currentTier === tierName)
        .sort((a, b) => (Number(b.prepaymentAmount) || 0) - (Number(a.prepaymentAmount) || 0))
        .slice(0, 50)
        .map(c => ({
            username: c.username,
            email: c.email,
            country: (c.country && c.country.trim()) || "Unknown",
            revenue: Number(c.prepaymentAmount) || 0
        }));
});

// =========================================
// TOP AFFILIATES BY TIER (Top 50 per tier)
// =========================================
const topAffiliatesByTier = {};
try {
    const AffiliateModel = require("./models/Affiliate.model");
    const allAffiliates = await AffiliateModel.find({ isActive: true });

    tierList.forEach(tierName => {
        const tierAffiliates = allAffiliates.map(aff => {
            // Filter referrals for this specific tier
            const tierReferrals = aff.referrals.filter(r => r.tier === tierName && r.status === 'confirmed');
            const tierCommission = tierReferrals.reduce((sum, r) => sum + (r.commissionEarned || 0), 0);
            return {
                username: aff.username,
                referrals: tierReferrals.length,
                commission: tierCommission
            };
        }).filter(a => a.referrals > 0)
          .sort((a, b) => b.commission - a.commission)
          .slice(0, 50);

        topAffiliatesByTier[tierName] = tierAffiliates;
    });
} catch (e) {
    tierList.forEach(tierName => {
        topAffiliatesByTier[tierName] = [];
    });
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
          positiveLogouts,
          topEarnersByTier,
        topAffiliatesByTier,
        tierList,
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
    try {
        const days = parseInt(req.body.durationDays) || 30; 
        const tier = req.body.tierLevel || "Unknown"; 
        const user = await User.findById(req.params.id);
        
        if (!user) {
            req.flash("error", "User not found.");
            return res.redirect("/admin");
        }
        
        user.licenseKey = crypto.randomBytes(6).toString('hex').toUpperCase(); 
        user.licenseExpiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000); 
        user.currentTier = tier; 
        user.isSuspended = false; 
        user.accountLocked = false; // Unlock when new license is issued
        await user.save();
        
        req.flash("success", `Generated ${days}-day ${tier} License for ${user.username}`);
        res.redirect("/admin");
    } catch (err) {
        req.flash("error", "Could not generate license.");
        res.redirect("/admin");
    }
});

app.post("/admin/suspend-license/:id", isAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            req.flash("error", "User not found.");
            return res.redirect("/admin");
        }
        
        user.isSuspended = !user.isSuspended;
        await user.save();
        
        req.flash("success", `Participant ${user.isSuspended ? 'Suspended' : 'Restored'}.`);
        res.redirect("/admin");
    } catch (err) {
        req.flash("error", "Could not update suspension status.");
        res.redirect("/admin");
    }
});

app.post("/admin/delete-user/:id", isAdmin, async (req, res) => {
    try {
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) {
            req.flash("error", "User not found.");
            return res.redirect("/admin");
        }
        
        req.flash("success", "Participant permanently deleted from the network.");
        res.redirect("/admin");
    } catch (err) {
        req.flash("error", "Could not delete user.");
        res.redirect("/admin");
    }
});


// ==========================================
// AFFILIATE SYSTEM ROUTES
// ==========================================


// Generate unique referral code
function generateReferralCode() {
    return 'REF' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// --- AFFILIATE PAGE ---
app.get("/affiliate", async (req, res) => {
    let isAffiliate = false;
    let affiliateData = null;
    
    if (req.user) {
        affiliateData = await Affiliate.findOne({ userId: req.user._id });
        isAffiliate = !!affiliateData;
    }
    
    res.render("affiliate", { 
        currentUser: req.user || null,
        referralCode: req.query.ref || null,
        isAffiliate: isAffiliate,
        affiliate: affiliateData
    });
});

// --- JOIN AFFILIATE PROGRAM ---
app.post("/affiliate/join", isLoggedIn, async (req, res) => {
    try {
        // Check if already an affiliate
        let existingAffiliate = await Affiliate.findOne({ userId: req.user._id });
        if (existingAffiliate) {
            req.flash("success", "You're already an affiliate! Here's your dashboard.");
            return res.redirect("/affiliate/dashboard");
        }

        // Use the static method to create with auto-generated code
        const affiliate = await Affiliate.createWithCode({
            userId: req.user._id,
            username: req.user.username,
            email: req.user.email,
            commissionRate: 20
        });
        
        console.log(`[AFFILIATE] New affiliate: ${affiliate.username} (${affiliate.referralCode})`);
        
        req.flash("success", "Welcome to the D.E.T Affiliate Program! Share your link to earn 20% commissions.");
        res.redirect("/affiliate/dashboard");
    } catch (err) {
        console.error("Affiliate join error:", err);
        req.flash("error", "Could not join affiliate program. Error: " + err.message);
        res.redirect("/affiliate");
    }
});

// --- AFFILIATE DASHBOARD ---
app.get("/affiliate/dashboard", isLoggedIn, async (req, res) => {
    try {
        const affiliate = await Affiliate.findOne({ userId: req.user._id });
        
        if (!affiliate) {
            req.flash("error", "Please join the affiliate program first.");
            return res.redirect("/affiliate");
        }

        // Get recent referrals
        const recentReferrals = affiliate.referrals
            .sort((a, b) => b.referredAt - a.referredAt)
            .slice(0, 10);

        // Get click stats for last 30 days
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const recentClicks = affiliate.clickHistory.filter(c => c.clickedAt > thirtyDaysAgo);

        res.render("affiliate-dashboard", {
            affiliate,
            recentReferrals,
            recentClicks: recentClicks.length,
            currentUser: req.user
        });
    } catch (err) {
        console.error("Affiliate dashboard error:", err);
        req.flash("error", "Could not load affiliate dashboard.");
        res.redirect("/dashboard");
    }
});

// --- AFFILIATE REQUEST PAYOUT ---
app.post("/affiliate/request-payout", isLoggedIn, async (req, res) => {
    try {
        const affiliate = await Affiliate.findOne({ userId: req.user._id });
        
        if (!affiliate) {
            req.flash("error", "Affiliate account not found.");
            return res.redirect("/affiliate/dashboard");
        }

        const minPayout = 50; // Minimum $50 payout
        if (affiliate.pendingEarnings < minPayout) {
            req.flash("error", `Minimum payout is $${minPayout}. You have $${affiliate.pendingEarnings.toFixed(2)} pending.`);
            return res.redirect("/affiliate/dashboard");
        }

        // Create payout request
        const payoutRequest = {
            amount: affiliate.pendingEarnings,
            method: req.body.method || 'bank_transfer',
            reference: 'PAY-' + Date.now(),
            status: 'pending',
            requestedAt: new Date()
        };

        affiliate.paymentHistory.push(payoutRequest);
        affiliate.pendingEarnings = 0;
        await affiliate.save();

        req.flash("success", `Payout request of $${payoutRequest.amount.toFixed(2)} submitted successfully!`);
        res.redirect("/affiliate/dashboard");
    } catch (err) {
        console.error("Payout request error:", err);
        req.flash("error", "Could not process payout request.");
        res.redirect("/affiliate/dashboard");
    }
});



// --- TRACK AFFILIATE CLICKS ---
app.get("/affiliate/click/:refCode", async (req, res) => {
    try {
        const affiliate = await Affiliate.findOne({ referralCode: req.params.refCode });
        
        if (affiliate && affiliate.isActive) {
            // Track click
            affiliate.clickHistory.push({
                ip: req.ip,
                userAgent: req.get('User-Agent') || 'Unknown',
                referrer: req.get('Referrer') || 'direct',
                clickedAt: new Date()
            });
            affiliate.totalClicks += 1;
            await affiliate.save();
            console.log(`[AFFILIATE] Click tracked for ${affiliate.username} (${affiliate.referralCode})`);
        }

        // Redirect to registration page with referral code
        res.redirect(`/register?ref=${req.params.refCode}`);
    } catch (err) {
        console.error("Affiliate click tracking error:", err);
        res.redirect("/register");
    }
});

// --- PROCESS AFFILIATE COMMISSION (called after successful payment) ---
async function processAffiliateCommission(newUserId, amountPaid, tierName) {
    try {
        const newUser = await User.findById(newUserId);
        if (!newUser || !newUser.referredBy) return;

        // Find the affiliate by referral code
        const affiliate = await Affiliate.findOne({ referralCode: newUser.referredBy });
        if (!affiliate || !affiliate.isActive) return;

        // Calculate commission
        const commissionRate = affiliate.commissionRate / 100;
        const commission = amountPaid * commissionRate;

        // Update affiliate record
        affiliate.referrals.push({
            userId: newUser._id,
            username: newUser.username,
            email: newUser.email,
            tier: tierName,
            amountPaid: amountPaid,
            commissionEarned: commission,
            status: 'confirmed',
            referredAt: new Date()
        });

        affiliate.totalReferrals += 1;
        affiliate.totalEarnings += commission;
        affiliate.pendingEarnings += commission;

        // Update user's affiliate commission
        const affiliateUser = await User.findById(affiliate.userId);
        if (affiliateUser) {
            affiliateUser.affiliateCommission = (affiliateUser.affiliateCommission || 0) + commission;
            await affiliateUser.save();
        }

        await affiliate.save();
        console.log(`[AFFILIATE] Commission of $${commission.toFixed(2)} credited to ${affiliate.username}`);
    } catch (err) {
        console.error("Process affiliate commission error:", err);
    }
}

// --- ADMIN: AFFILIATE MANAGEMENT ---
app.get("/admin/affiliates", isAdmin, async (req, res) => {
    try {
        const affiliates = await Affiliate.find({}).sort({ totalEarnings: -1 });
        
        let totalCommissions = 0;
        let totalPending = 0;
        let totalPaid = 0;
        
        affiliates.forEach(a => {
            totalCommissions += a.totalEarnings;
            totalPending += a.pendingEarnings;
            totalPaid += a.paidEarnings;
        });

        res.render("admin-affiliates", {
            affiliates,
            stats: {
                total: affiliates.length,
                totalCommissions,
                totalPending,
                totalPaid,
                totalReferrals: affiliates.reduce((sum, a) => sum + a.totalReferrals, 0),
                totalClicks: affiliates.reduce((sum, a) => sum + a.totalClicks, 0)
            },
            currentUser: req.user
        });
    } catch (err) {
        console.error("Admin affiliates error:", err);
        req.flash("error", "Could not load affiliate data.");
        res.redirect("/admin");
    }
});

// --- ADMIN: APPROVE AFFILIATE PAYOUT ---
app.post("/admin/affiliates/payout/:id", isAdmin, async (req, res) => {
    try {
        const affiliate = await Affiliate.findById(req.params.id);
        if (!affiliate) {
            req.flash("error", "Affiliate not found.");
            return res.redirect("/admin/affiliates");
        }

        // Find the most recent pending payout request
        const pendingRequest = affiliate.paymentHistory.find(p => p.status === 'pending');
        if (pendingRequest) {
            pendingRequest.status = 'paid';
            pendingRequest.paidAt = new Date();
            affiliate.paidEarnings += pendingRequest.amount;
        }

        await affiliate.save();
        req.flash("success", `Payout of $${pendingRequest?.amount?.toFixed(2) || '0'} approved for ${affiliate.username}.`);
        res.redirect("/admin/affiliates");
    } catch (err) {
        console.error("Affiliate payout error:", err);
        req.flash("error", "Could not process payout.");
        res.redirect("/admin/affiliates");
    }
});

// --- ADMIN: TOGGLE AFFILIATE STATUS ---
app.post("/admin/affiliates/toggle/:id", isAdmin, async (req, res) => {
    try {
        const affiliate = await Affiliate.findById(req.params.id);
        if (!affiliate) {
            req.flash("error", "Affiliate not found.");
            return res.redirect("/admin/affiliates");
        }

        affiliate.isActive = !affiliate.isActive;
        await affiliate.save();

        req.flash("success", `${affiliate.username}'s affiliate account ${affiliate.isActive ? 'activated' : 'deactivated'}.`);
        res.redirect("/admin/affiliates");
    } catch (err) {
        console.error("Toggle affiliate error:", err);
        req.flash("error", "Could not update affiliate status.");
        res.redirect("/admin/affiliates");
    }
});

// NEW: Process commission when payment is confirmed
async function processAffiliateCommissionOnPayment(user, amountPaid, tierName) {
    try {
        const affiliate = await Affiliate.findOne({ referralCode: user.referredBy });
        if (!affiliate || !affiliate.isActive) return;

        const commissionRate = affiliate.commissionRate / 100;
        const commission = amountPaid * commissionRate;

        // Find the pending referral for this user
        const pendingReferral = affiliate.referrals.find(
            r => r.userId && r.userId.toString() === user._id.toString() && r.status === 'pending'
        );

        if (pendingReferral) {
            // Update the existing pending referral
            pendingReferral.tier = tierName;
            pendingReferral.amountPaid = amountPaid;
            pendingReferral.commissionEarned = commission;
            pendingReferral.status = 'confirmed';
        } else {
            // Create new referral record
            affiliate.referrals.push({
                userId: user._id,
                username: user.username,
                email: user.email,
                tier: tierName,
                amountPaid: amountPaid,
                commissionEarned: commission,
                status: 'confirmed',
                referredAt: new Date()
            });
        }

        affiliate.totalEarnings += commission;
        affiliate.pendingEarnings += commission;

        // Update user's affiliate commission field
        const affiliateUser = await User.findById(affiliate.userId);
        if (affiliateUser) {
            affiliateUser.affiliateCommission = (affiliateUser.affiliateCommission || 0) + commission;
            await affiliateUser.save();
        }

        await affiliate.save();
        console.log(`[AFFILIATE] Commission of $${commission.toFixed(2)} confirmed for ${affiliate.username} from ${user.username}`);
    } catch (err) {
        console.error("Process affiliate commission error:", err);
    }
}

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


// ==========================================
// TRAINING ENROLLMENT ROUTES
// ==========================================

const Training = require("./models/Training.model");

// Training course config
const trainingCourses = {
    ECD: { name: "ECD Training", groupPrice: 300, oneOnOnePrice: 600, durationDays: 5, hoursPerDay: 3, minStudents: 5 },
    Beginner: { name: "Beginner Training", groupPrice: 500, oneOnOnePrice: 1000, durationDays: 5, hoursPerDay: 2, minStudents: 5 },
    Advanced: { name: "Advanced Training", groupPrice: 300, oneOnOnePrice: 600, durationDays: 5, hoursPerDay: 2, minStudents: 5 },
    Specialized: { name: "Specialized Training", groupPrice: 1000, oneOnOnePrice: 2000, durationDays: 14, hoursPerDay: 1, minStudents: 5 }
};

// Get training stats (for UI)
app.get("/api/training/status", async (req, res) => {
    try {
        const stats = {};
        for (const [key, config] of Object.entries(trainingCourses)) {
            const paidStudents = await Training.countDocuments({ courseKey: key, status: { $in: ['paid', 'confirmed', 'completed'] } });
            stats[key] = {
                enrolled: paidStudents,
                min: config.minStudents,
                status: paidStudents >= config.minStudents ? 'scheduled' : (paidStudents > 0 ? 'waiting' : 'waiting')
            };
        }
        res.json({ classes: stats, alerts: [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Initiate training enrollment (called from training page)
app.get("/training/enroll/:courseKey/:type", isLoggedIn, async (req, res) => {
    const { courseKey, type } = req.params;
    const config = trainingCourses[courseKey];
    
    if (!config) {
        req.flash("error", "Invalid course selected.");
        return res.redirect("/training");
    }
    
    const price = type === 'one-on-one' ? config.oneOnOnePrice : config.groupPrice;
    
    res.render("training-checkout", {
        courseKey,
        courseName: config.name,
        type: type === 'one-on-one' ? 'One-on-One' : 'Group',
        price,
        user: req.user
    });
});

// Process training payment via Paynow
app.post("/training/pay", isLoggedIn, async (req, res) => {
    const { courseKey, courseName, type, price } = req.body;
    
    try {
        // Create enrollment record
        const enrollment = new Training({
            courseKey,
            courseName,
            studentName: req.user.username,
            userId: req.user._id,
            email: req.user.email,
            whatsapp: req.user.whatsapp || '',
            country: req.user.country || '',
            type: type === 'One-on-One' ? 'one-on-one' : 'group',
            price: parseFloat(price),
            status: 'pending_payment'
        });
        
        const invoiceRef = `TRAIN-${req.user._id}-${courseKey}-${Date.now()}`;
        enrollment.paynowReference = invoiceRef;
        await enrollment.save();
        
        // Create Paynow payment
        let payment = paynow.createPayment(invoiceRef, req.user.email);
        payment.add(`${courseName} (${type})`, parseFloat(price));
        
        const response = await paynow.send(payment);
        
        if (response.success) {
            res.redirect(response.redirectUrl);
        } else {
            await Training.findByIdAndDelete(enrollment._id);
            req.flash("error", "Payment initiation failed. Please try again.");
            res.redirect("/training");
        }
    } catch (err) {
        console.error("Training payment error:", err);
        req.flash("error", "Could not process payment.");
        res.redirect("/training");
    }
});

// Training webhook (add to existing Paynow webhook or create new)
app.post("/api/training/paynow-update", async (req, res) => {
    const { reference, status, amount } = req.body;
    
    if (status === "Paid" || status === "Awaiting Delivery") {
        try {
            const enrollment = await Training.findOne({ paynowReference: reference });
            if (enrollment && enrollment.status === 'pending_payment') {
                enrollment.status = 'paid';
                enrollment.amountPaid = parseFloat(amount) || enrollment.price;
                enrollment.paidAt = new Date();
                await enrollment.save();
                console.log(`[TRAINING] Payment confirmed: ${enrollment.studentName} - ${enrollment.courseName} ($${amount})`);
            }
        } catch (err) {
            console.error("Training webhook error:", err);
        }
    }
    res.status(200).send("OK");
});

// Update the main Paynow webhook to also check training references
// Add this inside the existing app.post("/api/paynow/update"...) after the user check:
// (We'll handle it separately with a different resultUrl for training)

// Admin: View training enrollments
app.get("/admin/training", isAdmin, async (req, res) => {
    try {
        const enrollments = await Training.find({}).sort({ enrolledAt: -1 });
        
        const stats = {};
        for (const [key, config] of Object.entries(trainingCourses)) {
            const paid = enrollments.filter(e => e.courseKey === key && ['paid', 'confirmed', 'completed'].includes(e.status));
            stats[key] = {
                total: paid.length,
                group: paid.filter(e => e.type === 'group').length,
                oneOnOne: paid.filter(e => e.type === 'one-on-one').length,
                revenue: paid.reduce((sum, e) => sum + e.amountPaid, 0),
                minRequired: config.minStudents
            };
        }
        
        res.render("admin-training", {
            enrollments,
            courses: trainingCourses,
            stats,
            currentUser: req.user
        });
    } catch (err) {
        console.error("Admin training error:", err);
        req.flash("error", "Could not load training data.");
        res.redirect("/admin");
    }
});

// Admin: Confirm/update enrollment status
app.post("/admin/training/update/:id", isAdmin, async (req, res) => {
    const { status, notes } = req.body;
    try {
        const enrollment = await Training.findById(req.params.id);
        if (!enrollment) {
            req.flash("error", "Enrollment not found.");
            return res.redirect("/admin/training");
        }
        enrollment.status = status;
        if (notes) enrollment.notes = notes;
        if (status === 'completed') enrollment.completedAt = new Date();
        await enrollment.save();
        req.flash("success", `Enrollment updated to "${status}".`);
        res.redirect("/admin/training");
    } catch (err) {
        req.flash("error", "Could not update enrollment.");
        res.redirect("/admin/training");
    }
});


// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    req.flash("error", "Something went wrong. Please try again.");
    res.redirect("/");
});

// --- START SERVER ---
const port = process.env.PORT || 80;
app.listen(port, () => console.log(`ProTrading API running on port ${port}`));