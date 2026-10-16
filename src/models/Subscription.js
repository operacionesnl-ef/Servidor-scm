const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema({
  endpoint: { type: String, required: true, unique: true },
  expirationTime: { type: Number, default: null },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  },
  // backend
userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

module.exports = mongoose.model('Subscription', SubscriptionSchema);