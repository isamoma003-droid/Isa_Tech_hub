import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api/client.js';
import { useAction } from '../api/queries.js';
import PlatformForm from '../components/PlatformForm.jsx';
import { PageHeader, SecretReveal } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function NewPlatformPage() {
  const { canEdit, isMerchant } = useAuth();
  const [created, setCreated] = useState(null);
  const create = useAction((body) => api('/platforms', { method: 'POST', body }), [['platforms'], ['tills']]);

  if (!canEdit) return <Navigate to="/platforms" replace />;

  if (created) {
    return (
      <>
        <PageHeader title={`${created.platform.name} is ready`} subtitle="Give these two secrets to the platform's server. They are shown only once." />
        <div className="card stack">
          <SecretReveal title="API key" value={created.apiKey}>
            The platform's server sends this as <code>Authorization: Bearer …</code>. Keep it out of browsers and apps. Lost it? Issue a new one from the platform's page.
          </SecretReveal>
          <SecretReveal title="Webhook signing secret" value={created.webhookSecret}>
            The platform uses this to check that webhooks really come from IsaPay.
          </SecretReveal>
          <div className="form-actions">
            <Link to={`/platforms/${created.platform.id}`} className="btn btn-primary">
              I've saved them, continue
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Link to="/platforms" className="back">
        <ArrowLeft size={16} aria-hidden="true" /> Platforms
      </Link>
      <PageHeader
        title="Add a platform"
        subtitle={
          isMerchant
            ? 'Your site or app that will take M-Pesa payments through IsaPay. You get its API key and webhook secret next.'
            : 'A site or app that will take M-Pesa payments through IsaPay — your own platforms or a partner using IsaPay as their payment gateway.'
        }
      />
      <div className="card">
        <PlatformForm submitLabel="Create platform" busy={create.isPending} error={create.error} onSubmit={(body) => create.mutate(body, { onSuccess: setCreated })} />
      </div>
    </>
  );
}
