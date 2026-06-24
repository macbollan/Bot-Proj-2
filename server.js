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

// --- GLOBAL MEMORY FOR EA DATA ---
let activeTradesList = []; 
let eaBrainState = { 
    symbol: "Awaiting Connection...", 
    trend: "Unknown", action: "Scanning", price: 0.00, openTrades: 0,
    equityHistory: [] 
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
// 1. EA API ROUTES (How MT5 talks to your server)
// ==========================================

// A. Master EA Endpoint (Receives the master trades)
app.post("/api/master/update", (req, res) => {
    const { masterPassword, analysis, trades } = req.body;
    
   //if (masterPassword !== "YOUR_SECRET_MASTER_PASSWORD") {
     //   return res.status(403).json({ error: "Unauthorized" });
    //}
    
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
    
    if (trades) activeTradesList = trades;
    res.json({ status: "success" });
});

// B. Public Endpoint for the Web Dashboard Charts
app.get("/api/public/ea-state", (req, res) => res.json(eaBrainState));

// C. Client EA Endpoint (Verifies License & Locks MT5 Account)
app.post("/api/verify-license", async (req, res) => {
    const { licenseKey, accountNumber } = req.body;
    try {
      const user = await User.findOne({ licenseKey: licenseKey });
      
      if (!user) return res.json({ status: "rejected", reason: "Invalid License Key" });
      if (user.isSuspended) return res.json({ status: "rejected", reason: "Account Suspended by Admin" });
      if (new Date() > user.licenseExpiry) return res.json({ status: "rejected", reason: "License Expired" });
  
      if (!user.mt5AccountNumber) {
        user.mt5AccountNumber = accountNumber;
        await user.save();
      } else if (user.mt5AccountNumber !== Number(accountNumber)) {
        return res.json({ status: "rejected", reason: "License locked to a different MT5 Account" });
      }
      res.json({ status: "approved" });
    } catch (err) {
      res.json({ status: "error", reason: "Server error" });
    }
});

// D. Client EA Endpoint (Pulls the trades to copy)
app.get("/api/client/trades", async (req, res) => {
    const { licenseKey } = req.query;
    const user = await User.findOne({ licenseKey: licenseKey });
    
    if (!user || user.isSuspended || new Date() > user.licenseExpiry) {
        return res.status(403).json({ error: "License invalid, expired, or suspended" });
    }
    
    res.json({ trades: activeTradesList });
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
// PAYNOW INTEGRATION & TIER CONFIGURATION
// ==========================================

// WARNING: Replace with your actual Paynow Integration ID and Key
const paynow = new Paynow("YOUR_INTEGRATION_ID", "YOUR_INTEGRATION_KEY");

// Note: Paynow cannot send background webhooks to "localhost". 
// When you deploy to a live server, change this to your actual domain.
paynow.resultUrl = " https://f19c-41-173-57-29.ngrok-free.app/api/paynow/update"; 
paynow.returnUrl = " https://f19c-41-173-57-29.ngrok-free.app/checkout/return"; 

// Helper map: Ties the Tier name to the Price (USD/ZWL) and Duration (Days)
const tierConfig = {
    "Amethyst": { price: 30, durationDays: 30 },
    "Topaz": { price: 22, durationDays: 30 },
    "Tanzanite": { price: 100, durationDays: 30 },
    "Sapphire": { price: 900, durationDays: 210 }, // 7 months
    "Emerald": { price: 8000, durationDays: 210 },
    "Diamond": { price: 70000, durationDays: 210 },
    "Rhodium": { price: 500000, durationDays: 365 }, // 12 months
    "Platinum": { price: 4000000, durationDays: 365 },
    "Uranium": { price: 30000000, durationDays: 365 },
    "Atomic": { price: 200000000, durationDays: 365 },
    "Nuclear": { price: 1000000000, durationDays: 365 },
    "Solomonic": { price: 5000000000, durationDays: 365 }
};

// 1. INITIATE PAYMENT (Triggered when user clicks "Proceed to Secure Payment")
//app.post("/checkout/initialize", isLoggedIn, async (req, res) => {
  //  const { selectedTier } = req.body;
    //const config = tierConfig[selectedTier];
    
   // if (!config) {
     //   req.flash("error", "Invalid tier selected.");
       // return res.redirect("/pricing");
   // }

    // CREATE CUSTOM INVOICE REFERENCE: "UserID-TierName-Timestamp"
    // This is crucial. It travels to Paynow and back so we know WHO paid for WHAT.
    //const invoiceRef = `${req.user._id}-${selectedTier}-${Date.now()}`;
    
    //let payment = paynow.createPayment(invoiceRef, req.user.email);
    //payment.add(selectedTier + " EA License", config.price);

    //try {
      //  const response = await paynow.send(payment);
        //if (response.success) {
            // Redirect user securely to Paynow's checkout portal
          //  res.redirect(response.redirectUrl);
        //} else {
          //  console.log(response.error);
            //req.flash("error", "Failed to initiate payment gateway.");
            //res.redirect("/pricing");
        //}
    //} catch (error) {
      //  req.flash("error", "Payment gateway error.");
        //res.redirect("/pricing");
    //}
//});

// TEMPORARY FAKE CHECKOUT (For testing without Paynow Keys)
app.post("/checkout/initialize", isLoggedIn, async (req, res) => {
    const { selectedTier } = req.body;
    const config = tierConfig[selectedTier];
    
    try {
        const user = await User.findById(req.user._id);
        
        // Instantly generate the key as if they paid
        user.licenseKey = crypto.randomBytes(6).toString('hex').toUpperCase();
        user.licenseExpiry = new Date(Date.now() + config.durationDays * 24 * 60 * 60 * 1000);
        user.currentTier = selectedTier;
        user.prepaymentAmount = config.price;
        user.termsAgreed = true;
        user.isSuspended = false;
        user.mt5AccountNumber = null; 
        
        await user.save();
        
        req.flash("success", `TEST MODE: Successfully bypassed Paynow. ${selectedTier} License Generated!`);
        res.redirect("/dashboard");
    } catch (error) {
        req.flash("error", "Failed to generate test license.");
        res.redirect("/pricing");
    }
});

// 2. RETURN URL (Where user lands immediately after paying)
app.get("/checkout/return", isLoggedIn, (req, res) => {
    // We don't generate the license here because a user could fake this URL.
    // We wait for the silent webhook below.
    req.flash("success", "Payment processing! Your license key will generate automatically once the network confirms receipt.");
    res.redirect("/dashboard");
});

// 3. RESULT URL / WEBHOOK (Paynow pings this silently in the background)
app.post("/api/paynow/update", async (req, res) => {
    // Paynow sends us the status of the transaction
    const { reference, paynowreference, status } = req.body;
    
    // ONLY generate the key if the money is successfully paid
    if (status === "Paid") {
        // Extract the user ID and Tier from our custom reference string
        const parts = reference.split("-");
        const userId = parts[0];
        const tierName = parts[1];
        const config = tierConfig[tierName];

        try {
            const user = await User.findById(userId);
            if (user) {
                // THE GOLDEN GOOSE: Generating the License Key
                user.licenseKey = crypto.randomBytes(6).toString('hex').toUpperCase();
                user.licenseExpiry = new Date(Date.now() + config.durationDays * 24 * 60 * 60 * 1000);
                
                user.currentTier = tierName;
                user.prepaymentAmount = config.price;
                user.termsAgreed = true;
                user.isSuspended = false; // Unsuspend them if they were previously blocked
                user.mt5AccountNumber = null; // Un-lock MT5 account for the new cycle
                
                await user.save();
                console.log(`[SUCCESS] Payment received! License generated for ${user.username} (${tierName})`);
            }
        } catch (err) {
            console.error("Webhook database update failed:", err);
        }
    }
    
    // Paynow expects an "OK" response so it stops pinging us
    res.status(200).send("OK");
});

// ==========================================
// 2. WEB UI & AUTHENTICATION ROUTES
// ==========================================
app.get("/", (req, res) => res.render("index"));
app.get("/register", (req, res) => res.render("register"));

app.post("/register", async (req, res) => {
  try {
    const newUser = new User({ username: req.body.username, email: req.body.email });
    const registeredUser = await User.register(newUser, req.body.password);
    req.login(registeredUser, (err) => res.redirect("/dashboard"));
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
    const user = await User.findById(req.params.id);
    user.licenseKey = crypto.randomBytes(6).toString('hex').toUpperCase(); 
    user.licenseExpiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000); 
    user.isSuspended = false;
    await user.save();
    req.flash("success", `Generated ${days}-day License for ${user.username}`);
    res.redirect("/admin");
});

app.post("/admin/suspend-license/:id", isAdmin, async (req, res) => {
    const user = await User.findById(req.params.id);
    user.isSuspended = !user.isSuspended;
    await user.save();
    res.redirect("/admin");
});

// ==========================================
// DEVELOPER TESTING BACKDOOR (Delete before going live!)
// ==========================================
app.get("/dev/generate-key", async (req, res) => {
    try {
        // First, clear any old test accounts to prevent duplicates
        await User.deleteOne({ username: "DevTester" });

        const testUser = new User({
            username: "DevTester",
            email: "dev@protrading.com",
            licenseKey: "TEST-KEY-2026", // <--- Here is your permanent test key
            licenseExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // Valid for 30 days
            currentTier: "Topaz", // Testing with the $200-$1000 tier
            isSuspended: false,
            mt5AccountNumber: null, // Leaves it open to attach to whatever MT5 account you use
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