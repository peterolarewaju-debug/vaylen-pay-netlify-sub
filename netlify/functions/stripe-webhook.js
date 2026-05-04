// netlify/functions/stripe-webhook.js
// This function listens for Stripe's payment_intent.succeeded event
// and calls your Make webhook server-side — no browser dependency at all.

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const sig = event.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      webhookSecret,
    );
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // Only handle payment_intent.succeeded
  if (stripeEvent.type === "payment_intent.succeeded") {
    const paymentIntent = stripeEvent.data.object;
    const responder_uuid =
      paymentIntent.metadata && paymentIntent.metadata.responder_uuid;

    if (!responder_uuid) {
      console.log(
        "payment_intent.succeeded fired but no responder_uuid in metadata — skipping",
      );
      return { statusCode: 200, body: "ok" };
    }

    const MAKE_WEBHOOK =
      "https://hook.us2.make.com/d0xvi50mpajc2vycczlsef3w3gohcuph";
    const POST_PAYMENT_URL = process.env.POST_PAYMENT_URL;

    try {
      const response = await fetch(MAKE_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ responder_uuid }),
      });

      console.log(
        "Make webhook triggered. Status:",
        response.status,
        "| responder_uuid:",
        responder_uuid,
      );

      if (POST_PAYMENT_URL) {
        const customWebhookRes = await fetch(POST_PAYMENT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            responder_uuid,
            stripeMetadata: paymentIntent.metadata,
          }),
        });

        console.log(
          "Custom triggered.",
          customWebhookRes,
          "| responder_uuid:",
          responder_uuid,
        );
      }
    } catch (err) {
      console.error("Failed to call Make webhook:", err.message);
      // Return 200 to Stripe anyway so it does not retry
    }
  }

  return { statusCode: 200, body: "ok" };
};
