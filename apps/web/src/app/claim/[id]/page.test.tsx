import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page leans on Next's automatic JSX runtime; this vitest setup compiles JSX to
// `React.createElement`, so give it a global React to resolve.
(globalThis as { React?: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { getVouchMock, reverseHandleMock, getMetaMock, isVouchCancelledMock, claimVouchSignedMock } = vi.hoisted(
  () => ({
    getVouchMock: vi.fn(),
    reverseHandleMock: vi.fn(),
    getMetaMock: vi.fn(),
    isVouchCancelledMock: vi.fn(),
    claimVouchSignedMock: vi.fn(),
  }),
);

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/wallet/wallet-provider', () => ({
  useWallet: () => ({ connect: vi.fn().mockResolvedValue({ address: 'GCLAIMER' }), profile: null }),
}));
vi.mock('@/hooks/use-create-profile', () => ({
  useCreateProfile: () => ({ handle: '', setHandle: vi.fn(), normalizedHandle: '', avail: 'idle', creating: false, create: vi.fn() }),
}));
vi.mock('@/lib/reputation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reputation')>()),
  getVouch: getVouchMock,
  isVouchCancelled: isVouchCancelledMock,
  claimVouchSigned: claimVouchSignedMock,
}));
vi.mock('@/lib/registry', () => ({ reverseHandle: reverseHandleMock, getMeta: getMetaMock }));
vi.mock('@/components/fx/border-beam', () => ({ BorderBeam: () => null }));
vi.mock('@/components/ui/state-art', () => ({ StateArt: () => null }));
vi.mock('@/components/ui/sticker', () => ({ Sticker: () => null }));

import ClaimPage from './page';

const VOUCHER = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

describe('/claim/[id] — who vouched (#218)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.location.hash = '#k=ab';
    getVouchMock.mockResolvedValue({
      id: 7,
      from: VOUCHER,
      note: 'gm',
      claimed: false,
      claimer: null,
      created: Math.floor(Date.now() / 1000),
      stake: 5,
      slashed: false,
    });
    getMetaMock.mockResolvedValue(null);
    isVouchCancelledMock.mockResolvedValue(false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    await act(async () => root.render(<ClaimPage params={{ id: '7' }} />));
    for (let i = 0; i < 6; i++) await act(async () => Promise.resolve());
  }

  const claimButton = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Claim your star'));

  it('names the voucher by @handle and face, with a link to their profile', async () => {
    reverseHandleMock.mockResolvedValue('ayse');
    await renderPage();

    expect(container.querySelector('h1')?.textContent).toBe('@ayse vouched for you.');
    expect(container.querySelector('[aria-label="@ayse\'s profile face"]')).not.toBeNull();
    const link = container.querySelector<HTMLAnchorElement>('a[href="/u/ayse"]');
    expect(link?.target).toBe('_blank');
    expect(getMetaMock).toHaveBeenCalledWith(VOUCHER);
  });

  it('falls back cleanly for a voucher without a handle', async () => {
    reverseHandleMock.mockResolvedValue(null);
    await renderPage();

    expect(container.querySelector('h1')?.textContent).toBe('Someone vouched for you.');
    expect(container.textContent).toContain(`${VOUCHER.slice(0, 4)}…${VOUCHER.slice(-4)}`);
    expect(container.querySelector('a[href^="/u/"]')).toBeNull();
  });

  it('never holds the Claim button on a slow or failing lookup', async () => {
    reverseHandleMock.mockReturnValue(new Promise(() => {})); // never settles
    getMetaMock.mockRejectedValue(new Error('rpc down'));
    await renderPage();

    expect(claimButton()).toBeDefined();
    expect(claimButton()!.disabled).toBe(false);
    expect(container.querySelector('h1')?.textContent).toBe('Someone vouched for you.');
  });
});

describe('/claim/[id] — a card its voucher revoked (#137)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.location.hash = `#k=${'ab'.repeat(32)}`;
    getVouchMock.mockResolvedValue({
      id: 7,
      from: VOUCHER,
      note: 'gm',
      claimed: false,
      claimer: null,
      created: Math.floor(Date.now() / 1000),
      stake: 5,
      slashed: false,
    });
    reverseHandleMock.mockResolvedValue(null);
    getMetaMock.mockResolvedValue(null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    await act(async () => root.render(<ClaimPage params={{ id: '7' }} />));
    for (let i = 0; i < 6; i++) await act(async () => Promise.resolve());
  }

  const claimButton = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Claim your star'));

  it('shows the revoked state instead of a Claim button', async () => {
    isVouchCancelledMock.mockResolvedValue(true);
    await renderPage();

    expect(isVouchCancelledMock).toHaveBeenCalledWith(7);
    expect(container.querySelector('h1')?.textContent).toBe('This link was revoked.');
    expect(claimButton()).toBeUndefined();
    expect(container.querySelector('a[href="/app"]')).not.toBeNull();
  });

  it('keeps the card claimable when the flag cannot be read (a contract without is_cancelled)', async () => {
    isVouchCancelledMock.mockRejectedValue(new Error('simulate is_cancelled failed'));
    await renderPage();

    expect(claimButton()).toBeDefined();
    expect(container.querySelector('h1')?.textContent).toBe('Someone vouched for you.');
  });

  it('switches to the revoked state when the claim reverts with Cancelled (#16)', async () => {
    isVouchCancelledMock.mockResolvedValue(false); // revoked after the page loaded
    claimVouchSignedMock.mockRejectedValue(new Error('HostError: Error(Contract, #16)'));
    await renderPage();

    await act(async () => claimButton()!.click());
    for (let i = 0; i < 6; i++) await act(async () => Promise.resolve());

    expect(claimVouchSignedMock).toHaveBeenCalledWith({ address: 'GCLAIMER' }, 7, 'ab'.repeat(32));
    expect(container.querySelector('h1')?.textContent).toBe('This link was revoked.');
    expect(container.querySelector('.text-destructive')).toBeNull();
  });
});
