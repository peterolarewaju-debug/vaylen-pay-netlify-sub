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

    const price = body.price;
    const email = body.email;
    const promo = body.promo;
    const responder_uuid = body.responder_uuid || "";
    const planId = body.planId;
    const packageInMonths = body.packageInMonths;
    const amountCents = body.amountCents;
    const sync = body.sync;

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

    const p = await stripe.prices.retrieve(price);
    if (!p || !p.active || !p.unit_amount || !p.currency) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Price not usable" }),
      };
    }

    const unit_amount = p.unit_amount;
    const curr = p.currency.toLowerCase();

    let promoCents = 0;
    let promoStatus = "none";

    if (promo && String(promo).trim()) {
      const code = String(promo).trim();

      const pcList = await stripe.promotionCodes.list({
        code,
        active: true,
        limit: 1,
      });
      const pc = pcList.data[0];

      if (!pc) {
        promoStatus = "Code not found";
      } else if (!pc.coupon || !pc.coupon.valid) {
        promoStatus = "Coupon not valid";
      } else {
        const cpn = pc.coupon;
        if (cpn.amount_off != null) {
          if (!cpn.currency || cpn.currency.toLowerCase() === curr) {
            promoCents = Math.min(unit_amount, cpn.amount_off);
            promoStatus = promoCents > 0 ? "ok" : "none";
          } else {
            promoStatus = "Code currency mismatch";
          }
        } else if (cpn.percent_off != null) {
          promoCents = Math.floor(unit_amount * (cpn.percent_off / 100));
          promoCents = Math.min(promoCents, unit_amount);
          promoStatus = promoCents > 0 ? "ok" : "none";
        } else {
          promoStatus = "Unsupported coupon type";
        }
      }
    }

    let discountCents = promoCents;
    if (discount_override > 0 && discount_override > promoCents) {
      discountCents = Math.min(unit_amount, discount_override);
      if (
        promoStatus === "none" ||
        promoStatus === "Code not found" ||
        promoStatus === "Coupon not valid"
      ) {
        promoStatus = "ok";
      }
    }

    const final_amount = Math.max(50, unit_amount - discountCents);

    const intent = await stripe.paymentIntents.create({
      amount: final_amount,
      currency: curr,
      automatic_payment_methods: { enabled: true },
      ...(email ? { receipt_email: email } : {}),
      metadata: {
        source: "netlify-payment-element",
        price_id: price,
        base_amount: String(unit_amount),
        discount_cents: String(discountCents),
        promo_code_entered: promo || "",
        promo_status: promoStatus,
        responder_uuid: responder_uuid,
        amountCents,
        planId,
        packageInMonths,
        sync,
      },
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        clientSecret: intent.client_secret,
        subtotal: unit_amount,
        discount: discountCents,
        total: final_amount,
        promoStatus,
      }),
    };
  } catch (err) {
    console.error("[create-intent] ERROR:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Server error" }),
    };
  }
};
