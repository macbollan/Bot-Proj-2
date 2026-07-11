const mongoose = require("mongoose");

const AffiliateSchema = new mongoose.Schema({
    // Link to user account
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    username: { type: String, required: true },
    email: { type: String, required: true },
    
    // Unique referral code
    referralCode: { type: String, unique: true },
    
    // Affiliate link
    affiliateLink: { type: String },
    
    // Stats
    totalClicks: { type: Number, default: 0 },
    totalReferrals: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    pendingEarnings: { type: Number, default: 0 },
    paidEarnings: { type: Number, default: 0 },
    
    // Commission rate (percentage, e.g., 20 = 20%)
    commissionRate: { type: Number, default: 20 },
    
    // Referral tracking
    referrals: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        username: String,
        email: String,
        tier: String,
        amountPaid: Number,
        commissionEarned: Number,
        status: { type: String, enum: ['pending', 'confirmed', 'paid'], default: 'pending' },
        referredAt: { type: Date, default: Date.now },
        paidAt: Date
    }],
    
    // Click tracking
    clickHistory: [{
        ip: String,
        userAgent: String,
        referrer: String,
        clickedAt: { type: Date, default: Date.now }
    }],
    
    // Payment history
    paymentHistory: [{
        amount: Number,
        method: String,
        reference: String,
        status: { type: String, enum: ['pending', 'processing', 'paid', 'failed'], default: 'pending' },
        requestedAt: { type: Date, default: Date.now },
        paidAt: Date
    }],
    
    // Status
    isActive: { type: Boolean, default: true },
    joinedAt: { type: Date, default: Date.now }
});

// FIXED: Generate referral code when creating a new affiliate
AffiliateSchema.statics.createWithCode = async function(data) {
    const referralCode = 'REF' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const affiliateLink = `/register?ref=${referralCode}`;
    
    return this.create({
        ...data,
        referralCode,
        affiliateLink
    });
};

module.exports = mongoose.model("Affiliate", AffiliateSchema);