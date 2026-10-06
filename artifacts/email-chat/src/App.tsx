import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ClerkProvider, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, Compass, Inbox, LockKeyhole,
  LogOut, Mail, MessageCircle, MoreHorizontal, Plus, Search, Send, ShieldCheck,
  Sparkles, X,
} from 'lucide-react';
import { Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  getGetContactsQueryKey, getGetConversationsQueryKey, getGetDashboardQueryKey,
  getGetMessagesQueryKey, useAddContact, useCreateConversation, useGetContacts,
  useGetConversations, useGetDashboard, useGetMe, useGetMessages, useSendMessage,
} from '@workspace/api-client-react';
import type { ChatUser, Conversation, Message } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 4_000, refetchOnWindowFocus: true } },
});
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#285b4c',
    colorForeground: '#203a33',
    colorMutedForeground: '#71817a',
    colorDanger: '#b34b45',
    colorBackground: '#fbf8f0',
    colorInput: '#fffdf8',
    colorInputForeground: '#203a33',
    colorNeutral: '#d8d7cb',
    fontFamily: 'DM Sans, sans-serif',
    borderRadius: '0.8rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fbf8f0] rounded-[24px] w-[440px] max-w-full overflow-hidden border border-[#e2dfd3] shadow-xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#203a33] font-semibold tracking-tight',
    headerSubtitle: 'text-[#71817a]',
    socialButtonsBlockButtonText: 'text-[#203a33] font-medium',
    formFieldLabel: 'text-[#30463e] font-medium',
    footerActionLink: 'text-[#285b4c] font-semibold',
    footerActionText: 'text-[#71817a]',
    dividerText: 'text-[#71817a]',
    identityPreviewEditButton: 'text-[#285b4c]',
    formFieldSuccessText: 'text-[#285b4c]',
    alertText: 'text-[#843d38]',
    logoBox: 'mb-2',
    logoImage: 'h-9',
    socialButtonsBlockButton: 'border-[#deddd2] bg-[#fffdf8] hover:bg-[#f2f0e8]',
    formButtonPrimary: 'bg-[#285b4c] hover:bg-[#1e493d] text-white',
    formFieldInput: 'border-[#d8d7cb] bg-[#fffdf8] text-[#203a33]',
    footerAction: 'border-0',
    dividerLine: 'bg-[#deddd2]',
    alert: 'bg-[#fbefec] border-[#ead0cb]',
    otpCodeFieldInput: 'border-[#d8d7cb] bg-[#fffdf8]',
    formFieldRow: 'mb-4',
    main: 'gap-4',
  },
};

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) client.clear();
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, client]);
  return null;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function SignInPage() {
  return <AuthStage><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></AuthStage>;
}

function SignUpPage() {
  return <AuthStage><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></AuthStage>;
}

function AuthStage({ children }: { children: ReactNode }) {
  return (
    <main className="grain flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-[#f5f2e9] px-4 py-10">
      <div className="mb-8 flex items-center gap-3 animate-enter">
        <BrandMark /><span className="font-display text-[21px] font-extrabold tracking-[-.06em] text-[#203a33]">email chat</span>
      </div>
      <div className="animate-enter delay-1">{children}</div>
      <p className="mt-8 flex items-center gap-2 text-xs text-[#738078]"><LockKeyhole size={13} />Private by default. Just your email.</p>
    </main>
  );
}

function HomeRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) return <Redirect to="/chat" />;
  return <LandingPage />;
}

function ChatRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <AppLoading />;
  if (!isSignedIn) return <Redirect to="/" />;
  return <ChatWorkspace />;
}

function AppLoading() {
  return <div className="grid min-h-[100dvh] place-items-center bg-[#f5f2e9]" data-testid="status-app-loading"><div className="w-[280px] space-y-3"><div className="h-3 w-24 animate-pulse rounded-full bg-[#dfded3]" /><div className="h-10 animate-pulse rounded-2xl bg-[#e8e6dc]" /><div className="h-40 animate-pulse rounded-2xl bg-[#e8e6dc]" /></div></div>;
}

function BrandMark({ className = '' }: { className?: string }) {
  return <div className={`grid h-10 w-10 place-items-center rounded-[14px] bg-[#285b4c] text-[#d7efbb] shadow-[0_5px_16px_rgba(40,91,76,.2)] ${className}`} aria-hidden="true"><Mail size={19} strokeWidth={2.3} /></div>;
}

function LandingPage() {
  return (
    <main className="grain min-h-[100dvh] overflow-hidden bg-[#f5f2e9] text-[#203a33]">
      <header className="mx-auto flex max-w-[1320px] items-center justify-between px-6 py-6 md:px-12">
        <a href={basePath || '/'} className="flex items-center gap-3" data-testid="link-home-brand"><BrandMark /><span className="font-display text-[20px] font-extrabold tracking-[-.06em]">email chat</span></a>
        <nav className="flex items-center gap-3"><a href={`${basePath}/sign-in`} className="hidden px-4 py-2.5 text-sm font-semibold text-[#52675e] hover:text-[#203a33] sm:inline-flex" data-testid="link-sign-in">Sign in</a><a href={`${basePath}/sign-up`} className="inline-flex items-center gap-2 rounded-full bg-[#285b4c] px-5 py-3 text-sm font-semibold text-[#fbf8f0] transition hover:-translate-y-0.5 hover:bg-[#1e493d]" data-testid="link-get-started">Get started <ArrowUpRight size={15} /></a></nav>
      </header>
      <section className="mx-auto grid max-w-[1320px] items-center gap-12 px-6 pb-20 pt-10 md:grid-cols-[1.05fr_.95fr] md:px-12 md:pb-28 md:pt-16">
        <div className="animate-enter relative z-10">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#d9d9cc] bg-[#eeece2] px-3.5 py-2 text-[11px] font-bold uppercase tracking-[.13em] text-[#506960]"><span className="h-1.5 w-1.5 rounded-full bg-[#74a788]" /> Messages that feel like yours</div>
          <h1 className="font-display max-w-[700px] text-[clamp(3.5rem,8.1vw,7.5rem)] font-extrabold leading-[.91] tracking-[-.085em] text-[#203a33]">A chat app.<br /><span className="relative inline-block text-[#4c806b]">Without</span><br />the number.</h1>
          <p className="mt-8 max-w-[500px] text-lg leading-8 text-[#64756d]">Good conversations shouldn’t need your phone number. Find your people by email and keep the conversation somewhere that feels familiar.</p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <a href={`${basePath}/sign-up`} className="group inline-flex items-center gap-3 rounded-full bg-[#285b4c] px-6 py-4 text-[15px] font-semibold text-[#fbf8f0] shadow-[0_10px_25px_rgba(40,91,76,.17)] transition hover:-translate-y-1" data-testid="link-create-account">Make an account <ArrowRight size={17} className="transition-transform group-hover:translate-x-1" /></a>
            <span className="text-sm text-[#78857d]">No phone number. Ever.</span>
          </div>
          <div className="mt-12 flex items-center gap-3 text-sm text-[#61726a]"><div className="flex -space-x-2"><span className="grid h-8 w-8 place-items-center rounded-full border-2 border-[#f5f2e9] bg-[#dae3c9] text-[10px] font-bold text-[#42624e]">E</span><span className="grid h-8 w-8 place-items-center rounded-full border-2 border-[#f5f2e9] bg-[#eed9c5] text-[10px] font-bold text-[#855e44]">M</span><span className="grid h-8 w-8 place-items-center rounded-full border-2 border-[#f5f2e9] bg-[#d8e6e0] text-[10px] font-bold text-[#3a6c5a]">+</span></div><span>Made for conversations, not contact lists.</span></div>
        </div>
        <div className="relative mx-auto w-full max-w-[570px] animate-enter delay-1">
          <div className="absolute -right-8 -top-6 h-44 w-44 rounded-full bg-[#dfe9d1] blur-[1px]" />
          <div className="absolute -bottom-10 -left-5 h-56 w-56 rounded-full bg-[#e9dfcd]" />
          <div className="relative rounded-[30px] border border-[#dfded3] bg-[#fbf9f2] p-3 shadow-[0_35px_80px_rgba(46,66,54,.12)]">
            <div className="flex h-[64px] items-center justify-between rounded-[21px] bg-[#f2f0e7] px-5">
              <div className="flex items-center gap-3"><BrandMark className="h-9 w-9 rounded-xl" /><div><div className="text-sm font-bold tracking-[-.02em]">Your conversations</div><div className="text-[11px] text-[#7c8880]">a quieter kind of connected</div></div></div><MoreHorizontal size={20} className="text-[#78857d]" />
            </div>
            <div className="px-5 pb-5 pt-6">
              <div className="mb-5 flex items-center justify-between"><div className="font-display text-2xl font-bold tracking-[-.05em]">Messages</div><div className="grid h-9 w-9 place-items-center rounded-full bg-[#285b4c] text-[#f6f4e9]"><Plus size={17} /></div></div>
              <div className="mb-5 flex items-center gap-2 rounded-xl border border-[#e5e2d8] bg-[#f7f5ed] px-3.5 py-3 text-sm text-[#9aa29b]"><Search size={15} /> Search conversations</div>
              <div className="space-y-1">
                <MockConversation initials="A" name="A little note to yourself" excerpt="Your conversations, your pace." tint="bg-[#dce8d2]" />
                <MockConversation initials="@" name="Find someone by email" excerpt="Start with an address, stay for the chat." tint="bg-[#eadcc9]" />
                <MockConversation initials="+" name="Add your first contact" excerpt="No number required. Just an email." tint="bg-[#d7e7e0]" />
              </div>
              <div className="mt-5 rounded-[18px] bg-[#e8efe4] px-4 py-3 text-[11px] font-medium leading-5 text-[#527164]"><ShieldCheck size={14} className="mr-1 inline" /> Built around email. Designed around you.</div>
            </div>
          </div>
          <div className="absolute -bottom-7 -right-3 hidden items-center gap-3 rounded-2xl border border-[#e3dfd4] bg-[#fcfaf3] px-4 py-3 shadow-lg sm:flex"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[#deead5] text-[#416d57]"><LockKeyhole size={16} /></div><div><div className="text-xs font-bold">Your inbox stays yours</div><div className="text-[10px] text-[#818b83]">No number sharing. No noise.</div></div></div>
        </div>
      </section>
      <section className="border-y border-[#dfded3] bg-[#eeece2]">
        <div className="mx-auto grid max-w-[1320px] gap-10 px-6 py-14 md:grid-cols-3 md:px-12 md:py-16">
          <Feature number="01" title="Email is enough." copy="Create your account and reach people using the address they already know." icon={<Mail size={18} />} />
          <Feature number="02" title="Feels instantly familiar." copy="A calm, simple place to keep one-to-one conversations moving." icon={<MessageCircle size={18} />} />
          <Feature number="03" title="Your number stays private." copy="There’s no phone field, number lookup, or address-book upload to worry about." icon={<LockKeyhole size={18} />} />
        </div>
      </section>
      <section className="mx-auto flex max-w-[1320px] flex-col items-start justify-between gap-8 px-6 py-16 md:flex-row md:items-end md:px-12 md:py-24">
        <div><p className="mb-4 text-[11px] font-bold uppercase tracking-[.18em] text-[#688276]">Small, personal, intentional</p><h2 className="font-display max-w-[650px] text-4xl font-extrabold leading-[1.02] tracking-[-.07em] md:text-6xl">A little less noise.<br />A lot more conversation.</h2></div>
        <a href={`${basePath}/sign-up`} className="inline-flex items-center gap-3 rounded-full border border-[#bdc9bd] px-5 py-3.5 text-sm font-semibold text-[#315a4c] transition hover:bg-[#e9eee4]" data-testid="link-join-email-chat">Join Email Chat <ArrowUpRight size={16} /></a>
      </section>
      <footer className="mx-auto flex max-w-[1320px] flex-col gap-3 border-t border-[#dfded3] px-6 py-7 text-xs text-[#78857d] sm:flex-row sm:items-center sm:justify-between md:px-12"><span className="font-semibold text-[#50665c]">email chat</span><span>Conversation, without the phone number.</span><a href={`${basePath}/sign-in`} className="font-semibold text-[#426b59]" data-testid="link-footer-sign-in">Already here? Sign in</a></footer>
    </main>
  );
}

function MockConversation({ initials, name, excerpt, tint }: { initials: string; name: string; excerpt: string; tint: string }) {
  return <div className="flex items-center gap-3 rounded-2xl px-2 py-3"><div className={`grid h-11 w-11 shrink-0 place-items-center rounded-[15px] ${tint} text-sm font-bold text-[#486653]`}>{initials}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-[#30463e]">{name}</div><div className="mt-1 truncate text-xs text-[#89928b]">{excerpt}</div></div><span className="h-1.5 w-1.5 rounded-full bg-[#8bb294]" /></div>;
}

function Feature({ number, title, copy, icon }: { number: string; title: string; copy: string; icon: ReactNode }) {
  return <article className="animate-enter"><div className="mb-5 flex items-center justify-between text-[#789082]"><span className="font-mono-ui text-xs">{number}</span><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#dce6d7] text-[#426b59]">{icon}</span></div><h3 className="font-display text-xl font-bold tracking-[-.04em]">{title}</h3><p className="mt-2 max-w-[310px] text-sm leading-6 text-[#758078]">{copy}</p></article>;
}

function ChatWorkspace() {
  const { user } = useUser();
  const client = useQueryClient();
  const meQuery = useGetMe();
  const dashboardQuery = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey(), refetchInterval: 30_000 } });
  const contactsQuery = useGetContacts({ query: { queryKey: getGetContactsQueryKey(), refetchInterval: 30_000 } });
  const conversationsQuery = useGetConversations({ query: { queryKey: getGetConversationsQueryKey(), refetchInterval: 8_000 } });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
  const { signOut } = useClerk();
  const messagesQuery = useGetMessages(selectedId ?? 0, {
    query: { enabled: selectedId !== null, queryKey: getGetMessagesQueryKey(selectedId ?? 0), refetchInterval: 4_000 },
  });
  const addContact = useAddContact();
  const createConversation = useCreateConversation();
  const sendMessage = useSendMessage();
  const conversations = conversationsQuery.data ?? [];
  const contacts = contactsQuery.data ?? [];
  const selectedConversation = conversations.find((item: Conversation) => item.id === selectedId);
  const filteredConversations = useMemo(() => conversations.filter((item: Conversation) => {
    const needle = search.trim().toLowerCase();
    return !needle || item.contact.displayName.toLowerCase().includes(needle) || item.contact.email.toLowerCase().includes(needle);
  }), [conversations, search]);
  const currentUserId = meQuery.data?.id ?? user?.id ?? '';
  const messages = messagesQuery.data ?? [];
  const messageEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, selectedId]);

  const openConversation = (contact: ChatUser) => {
    setFeedback('');
    createConversation.mutate({ data: { contactId: contact.id } }, {
      onSuccess: async (conversation) => {
        setSelectedId(conversation.id);
        setMobileConversationOpen(true);
        await client.invalidateQueries({ queryKey: getGetConversationsQueryKey() });
      },
      onError: () => setFeedback('Could not open this conversation. Please try again.'),
    });
  };

  const handleAddContact = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = contactEmail.trim();
    if (!email) return;
    setFeedback('');
    addContact.mutate({ data: { email } }, {
      onSuccess: (contact) => {
        client.invalidateQueries({ queryKey: getGetContactsQueryKey() });
        setContactEmail('');
        setContactDialogOpen(false);
        openConversation(contact);
        setFeedback(`Added ${contact.displayName || contact.email}. Starting a conversation…`);
      },
      onError: () => setFeedback('We couldn’t add that email. Check it and try again.'),
    });
  };

  const handleSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!selectedId || !content || sendMessage.isPending) return;
    sendMessage.mutate({ conversationId: selectedId, data: { content } }, {
      onSuccess: () => {
        setDraft('');
        setFeedback('');
        client.invalidateQueries({ queryKey: getGetMessagesQueryKey(selectedId) });
        client.invalidateQueries({ queryKey: getGetConversationsQueryKey() });
        client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      },
      onError: () => setFeedback('Message not sent. Please try again.'),
    });
  };

  const refreshChat = () => {
    client.invalidateQueries({ queryKey: getGetConversationsQueryKey() });
    if (selectedId !== null) client.invalidateQueries({ queryKey: getGetMessagesQueryKey(selectedId) });
  };

  const profileName = meQuery.data?.displayName || user?.fullName || user?.primaryEmailAddress?.emailAddress || 'Your account';
  const initials = profileName.split(/\s+/).map((word) => word[0]).slice(0, 2).join('').toUpperCase();

  return (
    <main className="grain min-h-[100dvh] bg-[#f5f2e9] p-0 text-[#203a33] md:p-4" data-testid="app-chat-workspace">
      <div className="mx-auto flex min-h-[100dvh] max-w-[1680px] overflow-hidden border-[#dfded3] bg-[#faf8f1] md:min-h-[calc(100dvh-32px)] md:rounded-[24px] md:border md:shadow-[0_20px_60px_rgba(37,59,47,.08)]">
        <aside className="hidden w-[72px] shrink-0 flex-col items-center justify-between border-r border-[#e4e2d8] bg-[#f2f0e7] py-5 md:flex">
          <div className="flex flex-col items-center gap-8"><a href={basePath || '/'} aria-label="Email Chat home" className="transition hover:rotate-[-4deg]" data-testid="link-chat-logo"><BrandMark className="h-11 w-11" /></a><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#e1e9dc] text-[#32604f]" title="Messages"><MessageCircle size={19} /></div></div>
          <div className="flex flex-col items-center gap-4"><button type="button" onClick={refreshChat} title="Refresh conversations" className="grid h-10 w-10 place-items-center rounded-xl text-[#738078] transition hover:bg-[#e7e6dc] hover:text-[#285b4c]" data-testid="button-refresh-chat"><Compass size={19} /></button><div className="h-px w-8 bg-[#ddded3]" /><button type="button" onClick={() => signOut({ redirectUrl: basePath || '/' })} title="Sign out" className="grid h-10 w-10 place-items-center rounded-full bg-[#dfe6d9] text-xs font-bold text-[#355b4a] transition hover:bg-[#cbd9ca]" data-testid="button-sign-out-rail">{initials || 'EC'}</button></div>
        </aside>
        <section className={`flex w-full shrink-0 flex-col border-r border-[#e4e2d8] bg-[#fbfaf5] md:w-[340px] lg:w-[370px] ${mobileConversationOpen ? 'hidden md:flex' : 'flex'}`}>
          <div className="px-5 pb-3 pt-6 md:px-6 md:pt-7">
            <div className="flex items-center justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[.17em] text-[#809086]">Your space</p><h1 className="font-display mt-1 text-[28px] font-extrabold tracking-[-.065em]" data-testid="text-inbox-title">Messages</h1></div><button type="button" onClick={() => { setContactDialogOpen(true); setFeedback(''); }} className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#285b4c] text-[#f5f2e9] transition hover:bg-[#1f4b3e]" aria-label="Add contact by email" data-testid="button-add-contact"><Plus size={20} /></button></div>
            <div className="mt-5 flex items-center gap-2 rounded-[14px] border border-[#e4e2d8] bg-[#f5f3eb] px-3.5 py-3 focus-within:border-[#93b09a]"><Search size={16} className="shrink-0 text-[#86938a]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name or email" className="w-full bg-transparent text-[13px] text-[#30463e] outline-none placeholder:text-[#9aa39b]" aria-label="Search conversations" data-testid="input-search-conversations" /><kbd className="hidden rounded border border-[#deded3] px-1.5 py-0.5 font-mono-ui text-[9px] text-[#9aa39b] sm:block">/</kbd></div>
            <div className="mt-5 flex items-center justify-between"><h2 className="text-[11px] font-bold uppercase tracking-[.13em] text-[#89948b]">Recent</h2><span className="font-mono-ui text-[10px] text-[#929b93]" data-testid="text-conversation-count">{dashboardQuery.data ? `${dashboardQuery.data.conversationCount} conversations` : ' '}</span></div>
            {dashboardQuery.data && <div className="mt-2 flex items-center justify-between text-[10px] text-[#929b93]" data-testid="summary-dashboard-counts"><span>{dashboardQuery.data.contactCount} contacts</span><span>{dashboardQuery.data.messageCount} messages sent</span></div>}
            {dashboardQuery.isError && <button type="button" onClick={() => dashboardQuery.refetch()} className="mt-2 text-[10px] font-semibold text-[#8c6659] underline underline-offset-2" data-testid="status-dashboard-error">Activity counts unavailable · retry</button>}
          </div>
          <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            {conversationsQuery.isLoading && <div className="space-y-2 px-2 pt-2" data-testid="status-conversations-loading">{[1, 2, 3, 4].map((item) => <div key={item} className="flex gap-3 rounded-2xl p-3"><div className="h-11 w-11 animate-pulse rounded-2xl bg-[#e9e8de]" /><div className="flex-1 space-y-2 pt-1"><div className="h-3 w-3/5 animate-pulse rounded bg-[#e9e8de]" /><div className="h-2.5 w-4/5 animate-pulse rounded bg-[#eeece3]" /></div></div>)}</div>}
            {conversationsQuery.isError && <div className="mx-2 mt-4 rounded-2xl border border-[#ecd5cc] bg-[#fbf0ec] p-4" data-testid="status-conversations-error"><p className="text-sm font-semibold text-[#824c42]">Conversations didn’t load.</p><button onClick={() => conversationsQuery.refetch()} className="mt-2 text-xs font-bold text-[#8c4e43] underline underline-offset-4" data-testid="button-retry-conversations">Try again</button></div>}
            {!conversationsQuery.isLoading && !conversationsQuery.isError && filteredConversations.length === 0 && <div className="mx-3 mt-8 rounded-[20px] border border-dashed border-[#dcded2] px-5 py-7 text-center" data-testid="status-conversations-empty"><div className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-[#e7eee1] text-[#527866]"><Inbox size={19} /></div><p className="mt-3 text-sm font-semibold">{search ? 'No matches found' : 'A quiet inbox, for now'}</p><p className="mt-1 text-xs leading-5 text-[#829087]">{search ? 'Try another name or email address.' : 'Add someone using their email to start talking.'}</p>{!search && <button onClick={() => setContactDialogOpen(true)} className="mt-4 text-xs font-bold text-[#35624f]" data-testid="button-empty-add-contact">Add a contact</button>}</div>}
            {!conversationsQuery.isLoading && filteredConversations.map((conversation: Conversation) => <ConversationRow key={conversation.id} conversation={conversation} active={selectedId === conversation.id} onClick={() => { setSelectedId(conversation.id); setMobileConversationOpen(true); }} testId={`row-conversation-${conversation.id}`} />)}
            {(contacts.length > 0 || contactsQuery.isLoading || contactsQuery.isError) && <div className="mx-3 mt-6 border-t border-[#e9e7dd] pt-4"><div className="mb-2 flex items-center justify-between px-1"><h2 className="text-[10px] font-bold uppercase tracking-[.15em] text-[#89948b]">People</h2><span className="font-mono-ui text-[10px] text-[#98a198]" data-testid="text-contact-count">{dashboardQuery.data?.contactCount ?? (contactsQuery.isLoading ? '…' : contacts.length)}</span></div>{contactsQuery.isLoading && <div className="space-y-2 px-2 py-2" data-testid="status-contacts-loading"><div className="h-8 animate-pulse rounded-xl bg-[#eeece3]" /><div className="h-8 animate-pulse rounded-xl bg-[#eeece3]" /></div>}{contactsQuery.isError && <div className="px-1 py-2" data-testid="status-contacts-error"><p className="text-[11px] text-[#8c6659]">Contacts didn’t load.</p><button type="button" onClick={() => contactsQuery.refetch()} className="mt-1 text-[10px] font-bold text-[#8c6659] underline" data-testid="button-retry-contacts">Try again</button></div>}{!contactsQuery.isLoading && !contactsQuery.isError && contacts.slice(0, 5).map((contact: ChatUser) => <button type="button" key={contact.id} onClick={() => openConversation(contact)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-[#f1f0e8]" data-testid={`button-start-conversation-${contact.id}`}><Avatar name={contact.displayName || contact.email} compact /><span className="min-w-0 flex-1 truncate text-xs font-medium text-[#607168]">{contact.displayName || contact.email}</span><ArrowUpRight size={13} className="text-[#97a097]" /></button>)}</div>}
          </div>
          <div className="border-t border-[#e6e4da] bg-[#f7f5ee] px-4 py-3.5"><div className="flex items-center gap-3"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#dce6d6] text-[11px] font-bold text-[#426450]" data-testid="avatar-current-user">{initials || 'EC'}</div><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold" data-testid="text-current-user-name">{profileName}</p><p className="truncate text-[10px] text-[#829087]" data-testid="text-current-user-email">{meQuery.data?.email || user?.primaryEmailAddress?.emailAddress || ''}</p></div><button type="button" title="Sign out" onClick={() => signOut({ redirectUrl: basePath || '/' })} className="grid h-8 w-8 place-items-center rounded-lg text-[#819087] transition hover:bg-[#e9e8df] hover:text-[#426450]" data-testid="button-sign-out"><LogOut size={16} /></button></div></div>
        </section>
        <section className={`min-w-0 flex-1 flex-col bg-[#f8f6ef] ${mobileConversationOpen ? 'flex' : 'hidden md:flex'}`} data-testid="panel-chat">
          {selectedConversation ? <><header className="flex h-[77px] shrink-0 items-center justify-between border-b border-[#e6e4da] bg-[#faf9f3] px-4 sm:px-7"><div className="flex min-w-0 items-center gap-3"><button type="button" onClick={() => setMobileConversationOpen(false)} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[#66776e] hover:bg-[#eeece3] md:hidden" aria-label="Back to conversations" data-testid="button-back-to-conversations"><ArrowLeft size={18} /></button><Avatar name={selectedConversation.contact.displayName || selectedConversation.contact.email} /><div className="min-w-0"><h2 className="truncate text-sm font-bold" data-testid="text-selected-contact">{selectedConversation.contact.displayName || selectedConversation.contact.email}</h2><p className="truncate text-[11px] text-[#859087]" data-testid="text-selected-contact-email">{selectedConversation.contact.email}</p></div></div><div className="flex items-center gap-1"><span className="hidden items-center gap-1.5 rounded-full bg-[#e9efe4] px-2.5 py-1.5 text-[10px] font-semibold text-[#63806d] sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-[#82aa88]" /> Email conversation</span><button type="button" onClick={refreshChat} aria-label="Refresh messages" className="grid h-9 w-9 place-items-center rounded-xl text-[#74847b] hover:bg-[#eeece3]" data-testid="button-refresh-messages"><Compass size={17} /></button></div></header>
          <div className="flex shrink-0 justify-center px-3 pt-5"><div className="rounded-full border border-[#e7e5db] bg-[#f5f3eb] px-3 py-1.5 text-[10px] font-medium text-[#929b92]" data-testid="text-private-conversation-note"><LockKeyhole size={11} className="mr-1 inline" /> A personal conversation, found by email</div></div>
          <div className="chat-scrollbar flex-1 overflow-y-auto px-4 py-6 sm:px-8 lg:px-12">
            {messagesQuery.isLoading && <div className="mx-auto max-w-[720px] space-y-4 pt-10" data-testid="status-messages-loading">{[0, 1, 2].map((i) => <div key={i} className={`h-14 w-2/3 animate-pulse rounded-2xl bg-[#e9e8de] ${i === 1 ? 'ml-auto w-1/2' : ''}`} />)}</div>}
            {messagesQuery.isError && <div className="mx-auto mt-12 max-w-sm rounded-2xl border border-[#ecd5cc] bg-[#fbf0ec] p-5 text-center" data-testid="status-messages-error"><p className="text-sm font-semibold text-[#824c42]">Messages aren’t available right now.</p><button type="button" onClick={() => messagesQuery.refetch()} className="mt-3 text-xs font-bold text-[#8c4e43] underline" data-testid="button-retry-messages">Retry loading</button></div>}
            {!messagesQuery.isLoading && !messagesQuery.isError && messages.length === 0 && <div className="mx-auto mt-[9vh] max-w-[330px] text-center" data-testid="status-messages-empty"><div className="mx-auto grid h-[54px] w-[54px] place-items-center rounded-[19px] bg-[#e3ebdf] text-[#4a705b]"><MessageCircle size={21} /></div><p className="font-display mt-4 text-xl font-bold tracking-[-.04em]">This is a fresh start.</p><p className="mt-2 text-sm leading-6 text-[#839087]">Send a note to {selectedConversation.contact.displayName || 'your contact'} and let the conversation begin.</p></div>}
            {!messagesQuery.isLoading && messages.length > 0 && <div className="mx-auto flex max-w-[760px] flex-col gap-3" data-testid="list-messages">{messages.map((message: Message, index: number) => <MessageBubble key={message.id} message={message} mine={message.senderId === currentUserId} showDate={index === 0 || dayLabel(message.createdAt) !== dayLabel(messages[index - 1].createdAt)} />)}</div>}
            <div ref={messageEndRef} />
          </div>
          <div className="shrink-0 px-4 pb-4 pt-2 sm:px-7 sm:pb-6 lg:px-12"><form onSubmit={handleSend} className="mx-auto max-w-[800px] rounded-[20px] border border-[#e0dfd5] bg-[#fbfaf5] p-2 shadow-[0_7px_20px_rgba(50,65,52,.04)] focus-within:border-[#b7cbb7]"><div className="flex items-end gap-2"><textarea value={draft} onChange={(event) => setDraft(event.target.value.slice(0, 4000))} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Write a message…" rows={1} className="max-h-32 min-h-[44px] flex-1 resize-y bg-transparent px-3 py-3 text-sm leading-5 text-[#30463e] outline-none placeholder:text-[#9aa39b]" aria-label="Write a message" data-testid="input-message-composer" /><span className="hidden pb-3 font-mono-ui text-[9px] text-[#a0a79f] sm:block">ENTER TO SEND</span><button type="submit" disabled={!draft.trim() || sendMessage.isPending} className="mb-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-[14px] bg-[#285b4c] text-[#faf8f1] transition hover:bg-[#1e493d] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Send message" data-testid="button-send-message">{sendMessage.isPending ? <span className="h-4 w-4 animate-pulse rounded-full bg-[#c9dfb9]" /> : <Send size={17} />}</button></div></form><div className="mt-2 flex justify-between px-1 text-[10px] text-[#9aa198]"><span>Private, direct, and just between you two.</span><span data-testid="text-message-character-count">{draft.length}/4000</span></div></div>
          </> : <div className="flex flex-1 flex-col items-center justify-center px-6 text-center" data-testid="panel-chat-empty"><div className="relative mb-6"><div className="grid h-[82px] w-[82px] place-items-center rounded-[28px] bg-[#e2ebdd] text-[#426b59]"><MessageCircle size={31} strokeWidth={1.7} /></div><span className="absolute -right-2 -top-2 grid h-7 w-7 place-items-center rounded-full border-4 border-[#f8f6ef] bg-[#c4d8b4] text-[#365e4a]"><Sparkles size={12} /></span></div><p className="text-[10px] font-bold uppercase tracking-[.17em] text-[#829087]">Your inbox, your pace</p><h2 className="font-display mt-3 text-[32px] font-extrabold leading-tight tracking-[-.065em]">Make room for<br />a good conversation.</h2><p className="mt-3 max-w-[350px] text-sm leading-6 text-[#7e8a81]">Choose a conversation or find someone new with the email address you already have.</p><button type="button" onClick={() => setContactDialogOpen(true)} className="mt-7 inline-flex items-center gap-2 rounded-full bg-[#285b4c] px-5 py-3 text-sm font-semibold text-[#faf8f1] transition hover:-translate-y-0.5 hover:bg-[#1e493d]" data-testid="button-empty-start-chat"><Plus size={16} /> Add someone by email</button><div className="mt-8 flex items-center gap-2 text-[10px] text-[#9aa197]"><ShieldCheck size={13} /> Phone numbers aren’t part of the conversation.</div></div>}
        </section>
      </div>
      {feedback && <div className="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-[#d9e3d6] bg-[#fbfaf5] px-4 py-3 text-xs font-medium text-[#42624e] shadow-lg" role="status" data-testid="status-action-feedback"><Check size={14} />{feedback}<button onClick={() => setFeedback('')} className="ml-2 text-[#78857d]" aria-label="Dismiss message" data-testid="button-dismiss-feedback"><X size={14} /></button></div>}
      {contactDialogOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#18352b]/35 px-4 py-6 backdrop-blur-[3px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setContactDialogOpen(false); }}><div role="dialog" aria-modal="true" aria-labelledby="add-contact-heading" className="w-full max-w-[440px] animate-enter rounded-[27px] border border-[#e0ded3] bg-[#fbfaf4] p-6 shadow-[0_30px_90px_rgba(24,53,43,.23)] sm:p-8" data-testid="dialog-add-contact"><div className="flex items-start justify-between"><div><div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#e3ecdf] text-[#426b59]"><Mail size={19} /></div><h2 id="add-contact-heading" className="font-display mt-5 text-[25px] font-extrabold tracking-[-.055em]">Find your person.</h2><p className="mt-1 text-sm text-[#7d8980]">All you need is their email address.</p></div><button type="button" onClick={() => setContactDialogOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl text-[#829087] hover:bg-[#eeece3]" aria-label="Close" data-testid="button-close-add-contact"><X size={17} /></button></div><form onSubmit={handleAddContact} className="mt-7"><label htmlFor="contact-email" className="mb-2 block text-xs font-semibold text-[#4c6257]">Email address</label><div className="flex items-center gap-2 rounded-[14px] border border-[#dcded3] bg-[#fffdf8] px-3.5 focus-within:border-[#91ad96]"><Mail size={16} className="shrink-0 text-[#829087]" /><input id="contact-email" type="email" required autoFocus value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="name@example.com" className="h-[48px] min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#a1a79f]" data-testid="input-contact-email" /></div><p className="mt-2 flex items-center gap-1.5 text-[11px] text-[#87938a]"><LockKeyhole size={12} /> No mobile numbers. No contact uploads.</p><button type="submit" disabled={!contactEmail.trim() || addContact.isPending || createConversation.isPending} className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-[#285b4c] py-3.5 text-sm font-semibold text-[#faf8f1] transition hover:bg-[#1e493d] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-submit-contact">{addContact.isPending ? 'Adding contact…' : <>Add contact and start chatting <ArrowRight size={15} /></>}</button></form></div></div>}
    </main>
  );
}

function Avatar({ name, compact = false }: { name: string; compact?: boolean }) {
  const palette = ['bg-[#dce8d2] text-[#42624e]', 'bg-[#eedfcd] text-[#805b42]', 'bg-[#d9e8e1] text-[#3e6b59]', 'bg-[#e6dfeb] text-[#665873]'];
  const tone = palette[(name.charCodeAt(0) || 0) % palette.length];
  const letters = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  return <div className={`grid shrink-0 place-items-center rounded-[15px] font-bold ${compact ? 'h-8 w-8 rounded-[11px] text-[10px]' : 'h-11 w-11 text-[12px]'} ${tone}`} aria-hidden="true">{letters || 'EC'}</div>;
}

function ConversationRow({ conversation, active, onClick, testId }: { conversation: Conversation; active: boolean; onClick: () => void; testId: string }) {
  const last = conversation.lastMessage;
  const preview = last?.content || 'Start your conversation';
  const time = last?.createdAt ? shortTime(last.createdAt) : '';
  return <button type="button" onClick={onClick} className={`flex w-full items-center gap-3 rounded-[17px] px-3 py-3 text-left transition ${active ? 'bg-[#e9eee5]' : 'hover:bg-[#f2f1e9]'}`} data-testid={testId}><Avatar name={conversation.contact.displayName || conversation.contact.email} /><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="truncate text-[13px] font-semibold text-[#30463e]" data-testid={`text-conversation-name-${conversation.id}`}>{conversation.contact.displayName || conversation.contact.email}</span><span className="shrink-0 font-mono-ui text-[9px] text-[#959d95]" data-testid={`text-conversation-time-${conversation.id}`}>{time}</span></span><span className="mt-1 block truncate text-[11px] text-[#829087]" data-testid={`text-conversation-preview-${conversation.id}`}>{preview}</span></span></button>;
}

function MessageBubble({ message, mine, showDate }: { message: Message; mine: boolean; showDate: boolean }) {
  return <div className="flex flex-col" data-testid={`message-item-${message.id}`}>{showDate && <div className="my-3 self-center rounded-full border border-[#e5e4da] bg-[#f3f1e9] px-3 py-1 font-mono-ui text-[9px] text-[#929a92]" data-testid={`text-message-date-${message.id}`}>{dayLabel(message.createdAt)}</div>}<div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[85%] rounded-[19px] px-4 py-3 sm:max-w-[74%] ${mine ? 'rounded-br-[7px] bg-[#285b4c] text-[#f6f4eb]' : 'rounded-bl-[7px] border border-[#e6e4da] bg-[#fbfaf5] text-[#364b42]'}`}><p className="whitespace-pre-wrap break-words text-[13px] leading-[1.65]" data-testid={`text-message-content-${message.id}`}>{message.content}</p><div className={`mt-1.5 flex items-center justify-end gap-1.5 font-mono-ui text-[9px] ${mine ? 'text-[#d0dfd0]' : 'text-[#98a097]'}`}><time dateTime={message.createdAt} data-testid={`text-message-time-${message.id}`}>{shortTime(message.createdAt)}</time>{mine && <CheckCheck size={12} />}</div></div></div></div>;
}

function shortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function dayLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Pick up where your conversations left off.' } }, signUp: { start: { title: 'Make room for conversation', subtitle: 'Create your account with email. No phone number needed.' } } }} routerPush={(to) => setLocation(stripBase(to))} routerReplace={(to) => setLocation(stripBase(to), { replace: true })}>
    <QueryClientProvider client={queryClient}><TooltipProvider><ClerkQueryClientCacheInvalidator /><RoutedErrorBoundary><Switch><Route path="/" component={HomeRoute} /><Route path="/chat" component={ChatRoute} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route component={NotFound} /></Switch></RoutedErrorBoundary><Toaster /></TooltipProvider></QueryClientProvider>
  </ClerkProvider>;
}

function App() {
  return <WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter>;
}

export default App;
