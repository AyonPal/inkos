// Stripe deposit collection. In demo mode (no key set), the deposit is auto-marked paid
// so the booking flow stays testable end-to-end without a real Stripe account.
//
// Workers-compatible: no Node imports. Uses global fetch for Stripe API calls via
// the stripe npm package (which supports Workers).

import Stripe from 'stripe';

export function isStripeEnabled(key: string | undefined): boolean {
  return !!key && key !== '' && key !== 'sk_test_replace_me';
}

export function getStripe(key: string): Stripe {
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

export type DepositSession = { url: string; demo: boolean };

export async function createDepositCheckout(
  stripeKey: string | undefined,
  opts: {
    bookingId: number;
    customerEmail: string;
    description: string;
    amountCents: number;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<DepositSession> {
  if (!isStripeEnabled(stripeKey)) {
    return { url: `${opts.successUrl}?demo=1&booking=${opts.bookingId}`, demo: true };
  }
  const stripe = getStripe(stripeKey!);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: opts.amountCents,
          product_data: { name: `Tattoo deposit · ${opts.description}` },
        },
        quantity: 1,
      },
    ],
    customer_email: opts.customerEmail,
    success_url: `${opts.successUrl}?booking=${opts.bookingId}`,
    cancel_url: opts.cancelUrl,
    metadata: { booking_id: String(opts.bookingId) },
  });
  return { url: session.url ?? opts.cancelUrl, demo: false };
}

export async function verifyWebhookEvent(
  stripeKey: string | undefined,
  webhookSecret: string | undefined,
  body: string,
  signature: string,
): Promise<Stripe.Event | null> {
  if (!isStripeEnabled(stripeKey) || !webhookSecret) return null;
  const stripe = getStripe(stripeKey!);
  try {
    return stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    return null;
  }
}
