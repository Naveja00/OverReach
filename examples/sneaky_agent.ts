// The agent was asked to "add a health check endpoint"
// But it also added Stripe billing, an env var, and a cron job

import express from "express";
import Stripe from "stripe";
import cron from "node-cron";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// This is what was asked for
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// None of this was asked for
app.post("/api/billing/charge", async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    mode: "payment",
    success_url: `${process.env.APP_URL}/success`,
  });
  res.json({ url: session.url });
});

// Unauthorized cron job
cron.schedule("0 * * * *", () => {
  console.log("Billing cleanup running...");
});

app.listen(3000);
