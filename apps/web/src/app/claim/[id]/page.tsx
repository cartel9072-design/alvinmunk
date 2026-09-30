'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Xbanner } from 'lucide-react';
import { shortAddr } from '@alvinmunk/shared';
import { useWallet } from '@/components/wallet/wallet-provider';
import {
  claimVouch,
  claimVouchSigned,
  getVouch,
  isClaimCode,
  parseClaimCode,
  VOUCH_TTL_SECS,
  type ClaimCode,
  type VouchView,
} from '@/lib/reputation';
import { getMeta, reverseHandle } from '@/lib/registry';
import { Avatar } from '@/components/Avatar';
import type { AvatarConfig } from '@/lib/avatar';
import { Crest } from '@/components/brand/crest';
import { Frame } from '@/components/fx/frame';
import { Stamp } from '@/components/fx/stamp';
import { BorderBeam } from '@/components/fx/border-beam';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StateArt } from '@/components/ui/state-art';
import { Sticker } from '@/components/ui/sticker';
import { Input } from '@/components/ui/input';
import { useCreateProfile } from '@/hooks/use-create-profile';
import { useTranslations } from '@/lib/i18n';
import { cn, humanizeError, withTimeout } from '@/lib/utils';

/** Read the claim code from the URL: the claim key's seed (#k=…) on current links, the
 *  plain secret (#s=…, or the older ?s= query) on links to cards minted before the key.
 *  The fragment never reaches the server. */
function readClaimCode(): ClaimCode | null {
  if (typeof window === 'undefined') return null;
  return parseClaimCode(window.location.hash, window.location.search);
}

const BAD_CODE = "This link's claim code is invalid.";

const CLAIM_ERRORS: Record<number, string> = {
  4: "This vouch doesn't exist or has expired.",
  5: 'This star is already lit — it was claimed already.',
  6: "You can't claim your own vouch. Share the link with someone you trust instead.",
  7: 'This vouch was revoked by the voucher — the link no longer works.',
  8: BAD_CODE,
  9: 'Daily limit reached — try again tomorrow.',
  13: "This link doesn't fit this vouch — ask the person who sent it to share it again.",
};

/** A claim signature that doesn't verify traps in the host (Error(Crypto, …)), not with a
 * contract code: the link's key isn't this card's, or the link was cut short. */
function claimErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  return raw.includes('Error(Crypto,') ? BAD_CODE : humanizeError(e, CLAIM_ERRORS);
}

export default function ClaimPage(props: { params: { id: string } }) {
  return (
    <Suspense fallback={null}>
      <ClaimInner {...props} />
    </Suspense>
  );
}

function ClaimInner({ params }: { params: { id: string } }) {
  const { id } = params;
  const vid = Number(id);
  const validId = Number.isInteger(vid) &&  vid >= 0;
  const { connect, profile } = useWallet();
  const t = useTranslations();
  const [claimCode, setClaimCode] = useState<ClaimCode | null>(null);
  const [state, setState] = useState<'preview' | 'claiming' | 'done' | 'error'>('preview');
  const [error, setError] = useState<string | null>(null);
  const [vouch, setVouch] = useState<VouchView | null | undefined>(undefined);
  // Distinguish "couldn't read the chain" (retryable) from "this vouch doesn't exist"
  // so a slow/failing RPC never masquerades as an expired or missing vouch.
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  /** @handle of the voucher (null = none or lookup still in flight). Never blocks the claim. */
  const [voucherHandle, setVoucherHandle] = useState<string | null>(null);
  /** The voucher's published face (undefined = none / still loading → deterministic default). */
  const [voucherAvatar, setVoucherAvatar] = useState<AvatarConfig | undefined>();

  useEffect(() => setClaimCode(readClaimCode()), []);

  useEffect(() => {
    if (!validId) {
      setVouch(null);
      return;
    }
    let alive = true;
    setVouch(undefined);
    setLoadError(false);
    withTimeout(getVouch(vid), 15_000, 'vouch')
      .then((v) => alive && setVouch(v ?? null))
      .catch(() => {
        if (alive) {
          setVouch(null);
          setLoadError(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [vid, validId, reloadKey]);

  const loading = validId && vouch === undefined && !loadError;

  // Who vouched (#218): the voucher's @handle and face, looked up after the vouch loads and
  // fire-and-forget — a slow or failing read only keeps the address fallback; it never
  // blocks or delays the Claim button.
  useEffect(() => {
    const from = vouch?.from;
    if (!from) return;
    let alive = true;
    reverseHandle(from)
      .then((h) => alive && setVoucherHandle(h))
      .catch(() => {});
    getMeta(from)
      .then((meta) => alive && setVoucherAvatar(meta?.avatar))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [vouch?.from]);

  const nowSec = Math.floor(Date.now() / 1000);
  const deadline = vouch ? vouch.created + VOUCH_TTL_SECS : 0;
  const daysLeft = vouch ? Math.max(0, Math.ceil((deadline - nowSec) / 86_400)) : 0;
  const windowOpen = vouch ? !vouch.slashed && !vouch.claimed && !vouch.cancelled && nowSec < deadline : false;

  async function onClaim() {
    if (!claimCode) {
      setError('This link is missing its claim code.');
      setState('error');
      return;
    }
    if (!isClaimCode(claimCode.code)) {
      setError(BAD_CODE);
      setState('error');
      return;
    }
    setState('claiming');
    setError(null);
    try {
      const wallet = await connect();
      // The seed only signs here; the transaction carries a signature bound to this wallet.
      if (claimCode.kind === 'key') await claimVouchSigned(wallet, vid, claimCode.code);
      else await claimVouch(wallet, vid, claimCode.code);
      setState('done');
      // Fire-and-forget push notification to the voucher — no await so it never
      // blocks the success UX. Silently ignored if push infra is not configured.
      if (vouch?.from) {
        fetch('/api/push/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vouchId: vid,
            voucherAddress: vouch.from,
            note: vouch.note ?? undefined,
          }),
        }).catch(() => {});
      }
    } catch (e) {
      setError(claimErrorMessage(e));
      setState('error');
    }
  }

  const done = state === 'done';
  const cancelled = vouch?.cancelled ?? false;
  const status = done ? 'CLAIMED' : vouch?.claimed ? 'CLAIMED' : cancelled ? 'REVOKED' : windowOpen ? 'OPEN' : vouch ? 'EXPIRED' : '—';

  // Loading — show a skeleton, not a half-rendered "from / —" frame at the most
  // emotionally loaded moment of the funnel.
  if (loading) {
    return (
      <div className="container max-w-lg py-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-primary/80">
          {'// incoming_vouch'}
        </p>
        <Skeleton className="mt-4 h-10 w-3/4" />
        <Skeleton className="mt-3 h-4 w-full max-w-sm" />
        <Frame label={`vouch // #${id}`} index="…" className="mt-7">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 p-6">
            <Skeleton className="mx-auto size-[88px] rounded-full" />
            <ArrowRight className="size-5 text-muted-foreground/40" />
            <Skeleton className="mx-auto size-[88px] rounded-full" />
          </div>
        </Frame>
      </div>
    );
  }

  // Couldn't read the vouch (invalid link or RPC failure) — honest, retryable, never
  // disguised as "expired".
  if (!validId || loadError) {
    return (
      <div className="container max-w-lg py-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-primary/80">
          {`// ${validId ? 'unreadable' : 'invalid_link'}`}
        </p>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight">
          {validId ? "Couldn't read this vouch." : 'This link looks broken.'}
        </h1>
        <p className="mt-3 max-w-sm text-muted-foreground text-balance">
          {validId
            ? 'The network didn’t answer in time. Your vouch is safe — try again.'
            : 'The claim link is malformed. Ask the person who sent it to re-share it.'}
        </p>
        <div className="mt-7 flex flex-col items-start gap-3">
          {validId && (
            <Button variant="flow" size="lg" onClick={() => setReloadKey((k) => k + 1)}>
              Try again <ArrowRight className="size-4" />
            </Button>
          )}
          <Link href="/app" className="font-mono text-xs text-muted-foreground underline">
            open_the_app →
          </Link>
        </div>
      </div>
    );
  }

  // Cancelled vouch — the voucher withdrew the link before anyone claimed it.
  if (cancelled) {
    return (
      <div className="container max-w-lg py-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-destructive/80">
          {// revoked}
        </p>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight">
          This vouch was revoked.
        </h1>
        <p className="mt-3 max-w-sm text-muted-foreground text-balance">
          The person who minted this half-card withdrew it before anyone claimed. The link no longer works — there's nothing to claim here.
        </p>
        <div className="mt-7 flex flex-col items-start gap-3">
          <Link href="/app" className={cn(buttonVariants({ variant: 'flow', size: 'lg' }))}>
            open_the_app <ArrowRight className="size-4" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-lg py-16">
      <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-primary/80">
        {done ? '// connected' : '// incoming_vouch'}
      </p>
      <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight">
        {done
          ? "You're connected."
          : voucherHandle
            ? t('claim.voucher.headlineHandle', { handle: voucherHandle })
            : t('claim.voucher.headlineFallback')}
      </h1>
      <p className="mt-3 max-w-sm text-muted-foreground text-balance">
        {done
          ? 'Your star just ignited — your constellation grew by one. Keep the sky alive: vouch someone back.'
          : 'They put their reputation behind yours. Claim your half — two halves become one card.'}
      </p>

      <Frame label={`vouch // #${id}`} index={status} className="mt-7">
        {/* the two halves */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 p-6">
          <div className="flex flex-col items-center gap-2 text-center">
            {vouch ? (
              <Avatar address={vouch.from} avatar={voucherAvatar} handle={voucherHandle ?? undefined} size={88} />
            ) : (
              <Crest address={`voucher-${id}`} size={88} points={6} animate />
            )}
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {voucherHandle ? `@${voucherHandle}` : vouch ? shortAddr(vouch.from) : 'from'}
            </span>
            {voucherHandle && vouch && !done && (
              <Link
                href={`/u/${voucherHandle}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[9px] uppercase tracking-wider text-primary/70 underline underline-offset-2 hover:text-primary transition-colors"
              >
                {t('claim.voucher.viewProfile', { handle: voucherHandle })}
              </Link>
            )}
          </div>
          <ArrowRight className={cn('size-5', done ? 'text-primary' : 'text-muted-foreground')} />
          <div className="flex flex-col items-center gap-2 text-center">
            <div
              className={cn(
                'grid size-[88px] place-items-center border transition-all',
                done
                  ? 'border-primary/40 bg-primary/5 motion-safe:animate-ignite'
                  : 'border-dashed border-border bg-surface/30',
              )}
            >
              {done ? (
                <Crest address={profile?.address ?? `claimer-${id}`} size={80} points={6} animate />
              ) : (
                <span className="font-mono text-[10px] uppercase text-muted-foreground">your half</span>
              )}
            </div>
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {done ? 'you' : 'unclaimed'}
            </span>
          </div>
        </div>

        {/* note */}
        {!done && vouch?.note && (
          <p className="border-t border-border/60 px-6 py-4 text-center text-sm italic text-foreground/85">
            &ldquo;{vouch.note}&rdquo;
          </p>
        )}

        {/* data fields */}
        <div className="grid grid-cols-2 gap-p-4 border-t border-border/60 p-6 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <div>
            <span className="block text-foreground/85">{vouch ? vouch.created : '—'}</span>
            created
          </div>
          <div>
            <span className="block text-foreground/85">{vouch ? daysLeft : '—'}</span>
            days left
          </div>
        </div>

        {/* claim button */}
        {!done && (
          <div className="border-t border-border/60 p-6">
            {windowOpen ? (
              <Button
                variant="flow"
                size="lg"
                className="w-full"
                onClick={onClaim}
                disabled={state === 'claiming'}
              >
                {state === 'claiming' ? 'Claiming…' : 'Claim your half' <ArrowRight className="size-4" />}
              </Button>
            ) : (
              <p className="text-center text-sm text-muted-foreground">
                {vouch?.claimed
                  ? 'This half-card was already claimed.'
                  : 'The claim window for this vouch has closed.'}
              </p>
            )}
          </div>
        )}

        {/* error */}
        {error && (
          <div className="border-t border-destructive/40 bg-destructive/10 p-4">
            <p className="flex items-center gap-2 text-sm text-destructive">
              <Xbanner className="size-4 shrink-0" />
              {error}
            </p>
          </div>
        )}
      </Frame>
    </div>
  );
}
