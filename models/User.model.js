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

    // In models/User.model.js, add:
referredBy: { type: String, default: null }, // Referral code of the affiliate who referred this user
affiliateCommission: { type: Number, default: 0 },

    // In models/User.model.js, add:
affiliateCommission: { type: Number, default: 0 },
    
    // --- S.M.A.R.T INTEGRATION (DOUBLING RULE) ---
    creditWalletBalance: { type: Number, default: 0 }, 
    startingBalance: { type: Number, default: 0 },
    targetBalance: { type: Number, default: 0 },       
    accountLocked: { type: Boolean, default: false },

    // --- TRAINING SYSTEM FIELDS (NEW) ---
    hasTraining: { type: Boolean, default: false },
    trainingEnrollments: [{
        classKey: { type: String, enum: ['ECD', 'Beginner', 'Advanced', 'Specialized'] },
        enrollmentDate: { type: Date, default: Date.now },
        isOneOnOne: { type: Boolean, default: false },
        price: Number,
        status: { 
            type: String, 
            enum: ['pending', 'active', 'completed', 'cancelled'],
            default: 'pending'
        },
        sessions: [{
            date: Date,
            startTime: String,
            endTime: String,
            attended: { type: Boolean, default: false },
            notificationSent: { type: Boolean, default: false }
        }],
        paymentReference: String,
        paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' }
    }],

     // --- EMAIL VERIFICATION FIELDS (NEW) ---
       isVerified: { type: Boolean, default: false },
    verificationCode: String,
    verificationCodeExpires: Date,
    
    // --- TRAINING NOTIFICATIONS ---
    trainingAlerts: [{
        type: { type: String, enum: ['enrollment', 'reminder', 'start', 'end', 'cancellation'] },
        message: String,
        sentAt: { type: Date, default: Date.now },
        read: { type: Boolean, default: false }
    }]
});

// Attach the authentication plugin correctly (Handles Node 26+ Module Exports)
UserSchema.plugin(passportLocalMongoose.default || passportLocalMongoose);

module.exports = mongoose.model("User", UserSchema);