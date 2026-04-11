// Stripe deposit collection. In demo mode (no key set), the deposit is auto-marked paid
// so the booking flow stays testable end-to-end without a real Stripe account.

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
export const stripeEnabled = !!key && key !== 'sk_test_replace_me';

export const stripe = stripeEnabled ? new Stripe(key as string) : null;

export type DepositSession = { url: string; demo: boolean };

export async function createDepositCheckout(opts: {
  bookingId: number;
  customerEmail: string;
  description: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
}): Promise<DepositSession> {
  if (!stripeEnabled || !stripe) {
    return { url: `${opts.successUrl}?demo=1&booking=${opts.bookingId}`, demo: true };
  }
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
