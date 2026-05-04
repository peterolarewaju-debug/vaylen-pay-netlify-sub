import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function handler(event) {
  // CORS for Webflow
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };
  }

  try {
    // ✅ includes responder_uuid
    const { price, email, responder_uuid } = JSON.parse(event.body || '{}');

    if (!price) {
      return { statusCode: 400, headers: cors(), body: 'Missing price' };
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: email || undefined,

      // ✅ keep metadata (for future webhook use)
      metadata: {
        responder_uuid: responder_uuid || ''
      },

      // ✅ FIXED: pass responder_uuid to success page
      success_url: `${process.env.SUCCESS_URL}?responder_uuid=${responder_uuid}`,
      cancel_url: process.env.CANCEL_URL,

      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true },
      allow_promotion_codes: true
    });

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({ url: session.url })
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: cors(), body: 'Server error' };
  }
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };
}
