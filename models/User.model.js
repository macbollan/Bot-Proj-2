const mongoose = require("mongoose");
const passportLocalMongoose = require("passport-local-mongoose");

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  
  // --- EA Licensing Fields ---
  licenseKey: { type: String, default: null },
  licenseExpiry: { type: Date, default: null },
  mt5AccountNumber: { type: Number, default: null },
  isSuspended: { type: Boolean, default: false }, 
  
  // --- NEW: Subscription & Tier Fields ---
  currentTier: { type: String, default: "Amber" },
  floatSize: { type: Number, default: 0 },
  prepaymentAmount: { type: Number, default: 0 },
  termsAgreed: { type: Boolean, default: false },
  
  dateCreated: { type: Date, default: Date.now },
  role: { type: String, default: "client" } 
});

UserSchema.plugin(passportLocalMongoose.default || passportLocalMongoose);
module.exports = mongoose.model("User", UserSchema);