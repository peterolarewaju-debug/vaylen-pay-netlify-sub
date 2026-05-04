// netlify/functions/create-subscription.js
// Creates a Stripe Customer + Subscription (instead of a one-time PaymentIntent).
// Returns the same { clientSecret, subtotal, discount, total, promoStatus } shape
// so the Webflow Payment Element works without any changes to the frontend UI.
// The subscription generates a Subscription ID that persists for recurring billing.

const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "ok" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const price            = body.price;
    const email            = body.email;
    const promo            = body.promo;
    const responder_uuid   = body.responder_uuid || "";
    const sync             = body.sync || "";
    const planId           = body.planId || "";
    const packageInMonths  = body.packageInMonths || "";
    const amountCents      = body.amountCents || "";

    const discount_override = (function () {
      const raw = body.discount_override;
      if (raw === undefined || raw === null || raw === "") return 0;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : 0;
    })();

    if (!price) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing price" }),
      };
    }

    // 1) Retrieve the Price to get unit_amount and currency
    const p = await stripe.prices.retrieve(price);
    if (!p || !p.active || !p.unit_amount || !p.currency) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Price not usable" }),
      };
    }

    const unit_amount = p.unit_amount;
    const curr        = p.currency.toLowerCase();

    // 2) Resolve promo code → coupon discount in cents
    let promoCents  = 0;
    let promoStatus = "none";
    let stripeCouponId = null;

    if (promo && String(promo).trim()) {
      const code = String(promo).trim();
      const pcList = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
      const pc = pcList.data[0];

      if (!pc) {
        promoStatus = "Code not found";
      } else if (!pc.coupon || !pc.coupon.valid) {
        promoStatus = "Coupon not valid";
      } else {
        const cpn = pc.coupon;
        stripeCouponId = cpn.id;
        if (cpn.amount_off != null) {
          if (!cpn.currency || cpn.currency.toLowerCase() === curr) {
            promoCents  = Math.min(unit_amount, cpn.amount_off);
            promoStatus = promoCents > 0 ? "ok" : "none";
          } else {
            promoStatus = "Code currency mismatch";
            stripeCouponId = null;
          }
        } else if (cpn.percent_off != null) {
          promoCents  = Math.floor(unit_amount * (cpn.percent_off / 100));
          promoCents  = Math.min(promoCents, unit_amount);
          promoStatus = promoCents > 0 ? "ok" : "none";
        } else {
          promoStatus = "Unsupported coupon type";
          stripeCouponId = null;
        }
      }
    }

    // 3) Apply discount_override (first-month welcome discount) if larger than promo
    let discountCents = promoCents;
    if (discount_override > 0 && discount_override > promoCents) {
      discountCents  = Math.min(unit_amount, discount_override);
      stripeCouponId = null; // override replaces coupon — we'll use trial_period_days=0 + coupon below
      if (promoStatus === "none" || promoStatus === "Code not found" || promoStatus === "Coupon not valid") {
        promoStatus = "ok";
      }
    }

    const final_amount = Math.max(50, unit_amount - discountCents);

    // 4) Find or create a Stripe Customer for this user
    let customer;
    if (email) {
      const existing = await stripe.customers.list({ email, limit: 1 });
      if (existing.data.length > 0) {
        customer = existing.data[0];
      } else {
        customer = await stripe.customers.create({
          email,
          metadata: { responder_uuid, sync },
        });
      }
    } else {
      customer = await stripe.customers.create({
        metadata: { responder_uuid, sync },
      });
    }

    // 5) Build subscription params
    //    We use add_invoice_items for a one-time first-month discount instead of
    //    a coupon on the subscription, so future renewals charge full price.
    const subscriptionParams = {
      customer:         customer.id,
      items:            [{ price }],
      payment_behavior: "default_incomplete",  // returns clientSecret immediately
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand:           ["latest_invoice.payment_intent"],
      metadata: {
        source:           "netlify-subscription",
        price_id:         price,
        base_amount:      String(unit_amount),
        discount_cents:   String(discountCents),
        promo_code_entered: promo || "",
        promo_status:     promoStatus,
        responder_uuid,
        sync,
        planId,
        packageInMonths:  String(packageInMonths),
        amountCents:      String(amountCents),
      },
    };

    // Apply first-month discount as an invoice item credit so only month 1 is discounted
    if (discountCents > 0) {
      // Add a negative invoice item = first-month credit
      await stripe.invoiceItems.create({
        customer:    customer.id,
        amount:      -discountCents,            // negative = credit
        currency:    curr,
        description: promo
          ? `Promo discount (${promo})`
          : "Welcome discount — first month",
      });
    }

    // 6) Create the subscription
    const subscription = await stripe.subscriptions.create(subscriptionParams);

    const invoice       = subscription.latest_invoice;
    const paymentIntent = invoice && invoice.payment_intent;

    if (!paymentIntent || !paymentIntent.client_secret) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Subscription created but no client secret returned" }),
      };
    }

    // 7) Return to Webflow — same shape as create-intent so frontend needs no changes
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        clientSecret:   paymentIntent.client_secret,
        subscriptionId: subscription.id,
        customerId:     customer.id,
        subtotal:       unit_amount,
        discount:       discountCents,
        total:          final_amount,
        promoStatus,
      }),
    };
  } catch (err) {
    console.error("[create-subscription] ERROR:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Server error" }),
    };
  }
};
