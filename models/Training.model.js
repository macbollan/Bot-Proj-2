const mongoose = require("mongoose");

const trainingSchema = new mongoose.Schema({
    courseKey: { type: String, required: true }, // ECD, Beginner, Advanced, Specialized
    courseName: { type: String, required: true },
    studentName: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    email: { type: String },
    whatsapp: { type: String },
    country: { type: String },
    type: { type: String, enum: ['group', 'one-on-one'], required: true },
    price: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },
    paynowReference: { type: String },
    status: { type: String, enum: ['pending_payment', 'paid', 'confirmed', 'completed', 'cancelled'], default: 'pending_payment' },
    enrolledAt: { type: Date, default: Date.now },
    paidAt: { type: Date },
    completedAt: { type: Date },
    notes: { type: String }
});

module.exports = mongoose.model("Training", trainingSchema);