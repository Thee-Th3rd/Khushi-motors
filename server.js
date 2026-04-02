require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// ========== MODELS ==========
const UserSchema = new mongoose.Schema({
  email: String,
  password: String,
  freeTrialsUsed: { type: Number, default: 0 },
  extraCredits: { type: Number, default: 0 }
});
const User = mongoose.model('User', UserSchema);

const DrivingSessionSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  mistakes: [String],
  corrections: [String],
  date: { type: Date, default: Date.now }
});
const DrivingSession = mongoose.model('DrivingSession', DrivingSessionSchema);

const CarSchema = new mongoose.Schema({
  name: String,
  price: String,
  imageUrl: String,
  isHighDemand: Boolean
});
const Car = mongoose.model('Car', CarSchema);

// ========== MIDDLEWARE ==========
const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization').replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) throw new Error();
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Please authenticate' });
  }
};

// ========== AUTH ROUTES ==========
app.post('/api/register', async (req, res) => {
  try {
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    const user = new User({ email: req.body.email, password: hashedPassword });
    await user.save();
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
    res.json({ token, user: { email: user.email, freeTrialsUsed: user.freeTrialsUsed, extraCredits: user.extraCredits } });
  } catch (err) {
    res.status(400).json({ error: 'Email already exists' });
  }
});

app.post('/api/login', async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user || !(await bcrypt.compare(req.body.password, user.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
  res.json({ token, user: { email: user.email, freeTrialsUsed: user.freeTrialsUsed, extraCredits: user.extraCredits } });
});

// ========== CARS ROUTE ==========
app.get('/api/cars', async (req, res) => {
  const cars = await Car.find();
  res.json(cars);
});

// ========== DRIVING SESSION (Check eligibility) ==========
app.get('/api/driving/eligibility', auth, (req, res) => {
  const remainingFree = Math.max(0, 15 - req.user.freeTrialsUsed);
  const totalAvailable = remainingFree + req.user.extraCredits;
  res.json({ canDrive: totalAvailable > 0, remainingFree, extraCredits: req.user.extraCredits });
});

app.post('/api/driving/save-session', auth, async (req, res) => {
  const { mistakes, corrections } = req.body;
  
  // Deduct trial/credit
  if (req.user.freeTrialsUsed < 15) {
    req.user.freeTrialsUsed += 1;
  } else if (req.user.extraCredits > 0) {
    req.user.extraCredits -= 1;
  } else {
    return res.status(400).json({ error: 'No driving credits left' });
  }
  await req.user.save();
  
  const session = new DrivingSession({ userId: req.user._id, mistakes, corrections });
  await session.save();
  res.json({ success: true, remainingFree: Math.max(0, 15 - req.user.freeTrialsUsed), extraCredits: req.user.extraCredits });
});

// ========== MECHANIC DIAGNOSTICS (AI simulation) ==========
app.post('/api/mechanic/diagnose', auth, async (req, res) => {
  const { mistakes } = req.body;
  const correctionMap = {
    'Off-track': 'Check wheel alignment and practice lane discipline.',
    'Speeding': 'Inspect brakes and reduce entry speed into corners.',
    'Hard Braking': 'Check brake pad wear and practice smoother deceleration.',
    'Aggressive Steering': 'Examine suspension bushings and improve steering control.'
  };
  const corrections = mistakes.map(m => correctionMap[m] || 'General inspection recommended.');
  res.json({ corrections });
});

// ========== STRIPE PAYMENT (Extra driving sessions) ==========
app.post('/api/create-checkout-session', auth, async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: '20 Extra Driving Sessions' },
        unit_amount: 999, // $9.99
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${process.env.FRONTEND_URL}/dashboard?success=true`,
    cancel_url: `${process.env.FRONTEND_URL}/dashboard?canceled=true`,
    metadata: { userId: req.user._id.toString(), credits: 20 }
  });
  res.json({ id: session.id });
});

// Webhook to add credits after payment
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  
  if (event.type === 'checkout.session.completed') {
    const { userId, credits } = event.data.object.metadata;
    const user = await User.findById(userId);
    if (user) {
      user.extraCredits += parseInt(credits);
      await user.save();
    }
  }
  res.json({ received: true });
});

// Seed initial cars (run once)
app.get('/api/seed-cars', async (req, res) => {
  await Car.deleteMany();
  const cars = [
    { name: 'Tesla Model S Plaid', price: '$129,990', imageUrl: 'https://images.unsplash.com/photo-1617788138017-80ad40651399', isHighDemand: true },
    { name: 'Lamborghini Revuelto', price: '$604,000', imageUrl: 'https://images.unsplash.com/photo-1621135802920-133df287f89c', isHighDemand: true },
    { name: 'Porsche Taycan Turbo', price: '$185,000', imageUrl: 'https://images.unsplash.com/photo-1614162692292-7ac56d7f7f1e', isHighDemand: true },
    { name: 'Mercedes-AMG GT', price: '$138,000', imageUrl: 'https://images.unsplash.com/photo-1605559424843-9e4c228bf1c2', isHighDemand: false }
  ];
  await Car.insertMany(cars);
  res.json({ message: 'Cars seeded!' });
});

app.listen(5000, () => console.log('Server running on port 5000'));
