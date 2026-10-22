import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Clock3, ShieldCheck, XCircle } from 'lucide-react';
import { publicApi } from '../api/client.js';
import { ErrorMessage, Field, Spinner } from '../components/ui.jsx';
import { formatKes } from '../utils/format.js';

const EMPTY = { phone: '', amount: '', name: '', email: '' };

export default function CheckoutPage() {
  const { slug } = useParams();
  const [link, setLink] = useState(null);
  const [platform, setPlatform] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [payment, setPayment] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    publicApi(`/checkout/${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then((result) => {
        setLink(result.paymentLink);
        setPlatform(result.platform);
        setForm((previous) => ({ ...previous, amount: result.paymentLink.amount?.toString() || '' }));
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError') setError(reason);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [slug]);

  const paymentId = payment?.id;
  const paymentStatus = payment?.status;
  const paymentReceipt = payment?.mpesaReceipt;

  useEffect(() => {
    const awaitingConfirmationCode = ['paid', 'disputed'].includes(paymentStatus) && !paymentReceipt;
    if (!paymentId || (paymentStatus !== 'pending' && !awaitingConfirmationCode)) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      publicApi(`/checkout/${encodeURIComponent(slug)}/payments/${paymentId}`)
        .then((result) => {
          if (!cancelled) setPayment(result.payment);
        })
        .catch((reason) => {
          if (!cancelled) setError(reason);
        });
    }, 5000);
    const stopAfterReceiptWait = awaitingConfirmationCode
      ? window.setTimeout(() => {
          cancelled = true;
          window.clearInterval(timer);
        }, 60_000)
      : undefined;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (stopAfterReceiptWait) window.clearTimeout(stopAfterReceiptWait);
    };
  }, [paymentId, paymentReceipt, paymentStatus, slug]);

  const onSubmit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setPayment(null);
    try {
      const result = await publicApi(`/checkout/${encodeURIComponent(slug)}/pay`, {
        method: 'POST',
        body: {
          phone: form.phone,
          amount: Number(form.amount),
          ...(link.collectName ? { name: form.name } : {}),
          ...(link.collectEmail ? { email: form.email } : {}),
          requestId: crypto.randomUUID(),
        },
      });
      setPayment(result.payment);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <main className="checkout-wrap"><Spinner label="Loading secure checkout…" /></main>;
  if (!link || error?.status === 404) {
    return (
      <main className="checkout-wrap">
        <section className="card checkout-card">
          <h1>Payment link unavailable</h1>
          <p>This payment link may have expired or been turned off. Contact the business for help.</p>
          <ErrorMessage error={error?.status !== 404 ? error : null} />
        </section>
      </main>
    );
  }

  return (
    <main className="checkout-wrap">
      <section className="card checkout-card">
        <div className="checkout-brand">IsaPay <span>secure checkout</span></div>
        <p className="checkout-merchant">Payment to {platform?.name}</p>
        <h1>{link.title}</h1>
        {link.description && <p className="checkout-description">{link.description}</p>}
        <div className="checkout-amount">
          <span>{link.amountType === 'fixed' ? 'Amount due' : 'Choose an amount'}</span>
          <strong>{link.amountType === 'fixed' ? formatKes(link.amount) : `${formatKes(link.minAmount)} – ${formatKes(link.maxAmount)}`}</strong>
        </div>

        {payment?.status === 'paid' ? (
          <div className="notice notice-ok checkout-result" role="status">
            <CheckCircle2 size={20} aria-hidden="true" />
            <div>
              <strong>Payment received</strong>
              <p>{payment.message}</p>
              {payment.mpesaReceipt && <p>M-Pesa confirmation code: <span className="mono">{payment.mpesaReceipt}</span></p>}
            </div>
          </div>
        ) : payment && ['failed', 'disputed'].includes(payment.status) ? (
          <div className="notice notice-error checkout-result" role="alert">
            <XCircle size={20} aria-hidden="true" />
            <div>
              <strong>{payment.status === 'disputed' ? 'Payment needs review' : 'Payment not completed'}</strong>
              <p>{payment.message}</p>
              {payment.mpesaReceipt && <p>M-Pesa confirmation code: <span className="mono">{payment.mpesaReceipt}</span></p>}
            </div>
          </div>
        ) : payment?.status === 'pending' ? (
          <div className="notice notice-info checkout-result" role="status">
            <Clock3 size={20} aria-hidden="true" />
            <div><strong>Check your phone</strong><p>Enter your M-Pesa PIN in the prompt. This page will update when Safaricom confirms the payment.</p></div>
          </div>
        ) : (
          <form className="stack checkout-form" onSubmit={onSubmit}>
            <ErrorMessage error={error} title="Checkout could not continue" />
            <Field label="M-Pesa phone number" hint="Use a Kenyan mobile number, for example 0712345678">
              <input type="tel" autoComplete="tel" inputMode="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} required maxLength={20} />
            </Field>
            {link.amountType === 'customer' && (
              <Field label="Amount (KES)">
                <input type="number" inputMode="numeric" min={link.minAmount} max={link.maxAmount} step="1" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} required />
              </Field>
            )}
            {link.collectName && (
              <Field label="Your name">
                <input autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={80} />
              </Field>
            )}
            {link.collectEmail && (
              <Field label="Email address" hint="We'll send a receipt after the payment is confirmed.">
                <input type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required maxLength={120} />
              </Field>
            )}
            <button type="submit" className="btn btn-primary btn-large btn-block" disabled={busy}>
              {busy ? 'Sending M-Pesa prompt…' : 'Pay with M-Pesa'}
            </button>
          </form>
        )}

        {payment && ['failed', 'disputed'].includes(payment.status) && (
          <button type="button" className="btn btn-primary btn-block" onClick={() => setPayment(null)}>Try payment again</button>
        )}
        <div className="checkout-security"><ShieldCheck size={16} aria-hidden="true" /> Your payment is processed securely through M-Pesa.</div>
        <p className="checkout-powered">Powered by IsaPay</p>
      </section>
    </main>
  );
}
