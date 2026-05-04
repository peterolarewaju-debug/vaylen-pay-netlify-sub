// netlify/functions/stripe-webhook.js
// Listens for Stripe subscription events and fires the Make webhook
// with subscription_id + responder_uuid so recurring billing is tracked.

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const sig           = event.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const MAKE_WEBHOOK    = "https://hook.us2.make.com/d0xvi50mpajc2vycczlsef3w3gohcuph";
  const POST_PAYMENT_URL = process.env.POST_PAYMENT_URL;

  // ── Handle subscription activated (first payment confirmed) ──────────────
  if (stripeEvent.type === "customer.subscription.updated" ||
      stripeEvent.type === "customer.subscription.created") {

    const subscription = stripeEvent.data.object;

    // Only act when the subscription becomes active (first payment succeeded)
    if (subscription.status !== "active") {
      console.log(`Subscription ${subscription.id} status is "${subscription.status}" — skipping`);
      return { statusCode: 200, body: "ok" };
    }

    const responder_uuid   = subscription.metadata?.responder_uuid || "";
    const sync             = subscription.metadata?.sync            || "";
    const subscription_id  = subscription.id;
    const customer_id      = subscription.customer;

    if (!responder_uuid) {
      console.log("Subscription active but no responder_uuid in metadata — skipping Make webhook");
      return { statusCode: 200, body: "ok" };
    }

    try {
      const payload = {
        responder_uuid,
        subscription_id,
        customer_id,
        sync,
        event_type: stripeEvent.type,
      };

      const response = await fetch(MAKE_WEBHOOK, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });

      console.log(
        "Make webhook triggered. Status:", response.status,
        "| responder_uuid:", responder_uuid,
        "| subscription_id:", subscription_id,
        "| sync:", sync
      );

      if (POST_PAYMENT_URL) {
        await fetch(POST_PAYMENT_URL, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            responder_uuid,
            subscription_id,
            customer_id,
            sync,
            stripeMetadata: subscription.metadata,
          }),
        });
      }
    } catch (err) {
      console.error("Failed to call Make webhook:", err.message);
      // Return 200 to Stripe anyway so it does not retry
    }
  }

  // ── Handle invoice payment succeeded (covers recurring renewals) ──────────
  if (stripeEvent.type === "invoice.payment_succeeded") {
    const invoice         = stripeEvent.data.object;
    const subscription_id = invoice.subscription;
    const customer_id     = invoice.customer;

    // Fetch subscription to get metadata
    if (subscription_id) {
      try {
        const subscription   = await stripe.subscriptions.retrieve(subscription_id);
        const responder_uuid = subscription.metadata?.responder_uuid || "";
        const sync           = subscription.metadata?.sync            || "";

        if (responder_uuid) {
          console.log(
            "Recurring payment succeeded | subscription_id:", subscription_id,
            "| responder_uuid:", responder_uuid,
            "| invoice:", invoice.id
          );
          // You can fire an additional Make webhook here for renewal tracking if needed
          // await fetch(MAKE_RENEWAL_WEBHOOK, { ... });
        }
      } catch (err) {
        console.error("Could not retrieve subscription for invoice:", err.message);
      }
    }
  }

  // ── Handle payment_intent.succeeded (fallback for non-subscription payments) ──
  if (stripeEvent.type === "payment_intent.succeeded") {
    const paymentIntent  = stripeEvent.data.object;
    const responder_uuid = paymentIntent.metadata?.responder_uuid || "";

    // Only fire Make if this PaymentIntent is NOT linked to a subscription
    // (subscription payments are handled above via invoice.payment_succeeded)
    if (responder_uuid && !paymentIntent.invoice) {
      try {
        await fetch(MAKE_WEBHOOK, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ responder_uuid }),
        });
        console.log("Make webhook triggered via payment_intent.succeeded | responder_uuid:", responder_uuid);
      } catch (err) {
        console.error("Failed to call Make webhook:", err.message);
      }
    }
  }

  return { statusCode: 200, body: "ok" };
};
