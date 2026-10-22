import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailTemplate } from '../src/services/emailTemplate.js';

test('IsaPay email template escapes customer content and renders a secure action link', () => {
  const html = emailTemplate({
    preheader: 'Payment details',
    title: '<Payment received>',
    greeting: 'Hello Amina & team',
    paragraphs: ['Your payment is confirmed.'],
    details: [{ label: 'Reference', value: '<script>alert(1)</script>' }],
    paragraphsAfterDetails: ['A customer message & reply.'],
    action: { label: 'Open account', url: 'https://isa.example/account?ref=one&next=two' },
  });

  assert.match(html, /IsaPay/);
  assert.match(html, /by ISA Tech/);
  assert.match(html, /&lt;Payment received&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /href="https:\/\/isa\.example\/account\?ref=one&amp;next=two"/);
  assert.match(html, /A customer message &amp; reply\./);
  assert.match(html, /role="presentation"/);
});

test('HTML emails remain accompanied by plain-text fallbacks in the mail transport', async () => {
  const { sendMail, setMailTransport } = await import('../src/services/mailer.js');
  let message;
  try {
    setMailTransport({ sendMail: async (mail) => { message = mail; } });
    assert.equal(await sendMail({ to: 'person@example.test', subject: 'Test', text: 'Plain version', html: '<p>HTML version</p>' }), true);
    assert.equal(message.text, 'Plain version');
    assert.equal(message.html, '<p>HTML version</p>');
  } finally {
    setMailTransport(null);
  }
});
