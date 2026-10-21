import { Link } from 'react-router-dom';

const faqs = [
  {
    question: 'What is IsaPay?',
    answer:
      'IsaPay is the ISA Tech Hub payments gateway that lets one M-Pesa till support many platform integrations with consistent webhooks, billing, and reconciliation.',
  },
  {
    question: 'Do I need to expose M-Pesa credentials in browser code?',
    answer:
      'No. All Daraja credentials and webhook secrets should stay on your secure backend. The dashboard and browser only use authenticated API calls to the Hub.',
  },
  {
    question: 'How do payments get reconciled?',
    answer:
      'Each payment creates a signed event and a webhook payload that you can use to confirm status, settle orders, and reconcile revenue across platforms.',
  },
  {
    question: 'Can I add multiple tills?',
    answer:
      'Yes. The Hub supports multiple configured M-Pesa tills, each with its own credentials and platform mapping.',
  },
];

export default function FAQPage() {
  return (
    <div className="page container">
      <header className="page-header">
        <div>
          <h1>Frequently asked questions</h1>
          <p className="subtitle muted">Answers about IsaPay and the ISA Tech Hub.</p>
        </div>
      </header>

      <article className="card stack">
        {faqs.map(({ question, answer }) => (
          <section key={question}>
            <h3>{question}</h3>
            <p>{answer}</p>
          </section>
        ))}

        <footer className="page-foot">
          <p>
            <Link to="/">Back to home</Link>
          </p>
        </footer>
      </article>
    </div>
  );
}
