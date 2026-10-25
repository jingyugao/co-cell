import { lazy, Suspense, type ComponentProps } from 'react';

const BillingRail = lazy(() => import('./BillingRail'));

/** Tokenizer dictionaries are needed only when the cost panel is opened. */
export default function LazyBillingRail(props: ComponentProps<typeof BillingRail>) {
  return <Suspense fallback={<aside className="billing-rail" role="status">正在加载费用估算…</aside>}>
    <BillingRail {...props} />
  </Suspense>;
}
