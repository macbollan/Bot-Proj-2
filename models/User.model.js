const mongoose = require("mongoose");
const passportLocalMongoose = require("passport-local-mongoose");

const UserSchema = new mongoose.Schema({
    // --- BASIC AUTH ---
    username: String,
    email: String,
    
    // --- STAGE ONE DIRECTIVE FIELDS ---
    whatsapp: String,
    mobileNumber: String,
    country: String,
    
    // --- LICENSE & MT5 DATA ---
    licenseKey: String,
    licenseExpiry: Date,
    currentTier: String,
    isSuspended: { type: Boolean, default: false },
    mt5AccountNumber: Number,
    prepaymentAmount: Number,
    termsAgreed: { type: Boolean, default: false },
    
    // --- S.M.A.R.T INTEGRATION (DOUBLING RULE) ---
    creditWalletBalance: { type: Number, default: 0 }, 
    startingBalance: { type: Number, default: 0 },
    targetBalance: { type: Number, default: 0 },       
    accountLocked: { type: Boolean, default: false }   
});

// Attach the authentication plugin correctly
// Attach the authentication plugin correctly (Handles Node 26+ Module Exports)
UserSchema.plugin(passportLocalMongoose.default || passportLocalMongoose);

module.exports = mongoose.model("User", UserSchema);