import { QueryClientProvider } from '@tanstack/react-query';
import { Tooltip } from 'radix-ui';

import { PrimitivesDemo } from '../features/demo/PrimitivesDemo';
import { Toaster } from '../ui/Toaster';
import { ConfirmDialog } from './errors/ConfirmDialog';
import { ErrorBoundary } from './ErrorBoundary';
import { queryClient } from './queryClient';
import { Shell } from './Shell';
import { useHash } from './useHash';

export function App() {
  // `#primitives` shows the primitives page, kept as a visual reference for `ui/`.
  const showPrimitives = useHash() === '#primitives';
  return (
    <QueryClientProvider client={queryClient}>
      {/* Non-hoverable tooltips close as soon as the pointer leaves: never two on screen. */}
      <Tooltip.Provider delayDuration={400} skipDelayDuration={200} disableHoverableContent>
        {/* The dialogs and the toaster are inside too: a render error anywhere shows the crash
            screen instead of unmounting the whole window. */}
        <ErrorBoundary>
          {showPrimitives ? <PrimitivesDemo /> : <Shell />}
          <ConfirmDialog />
          <Toaster />
        </ErrorBoundary>
      </Tooltip.Provider>
    </QueryClientProvider>
  );
}
