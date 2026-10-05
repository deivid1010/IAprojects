import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApiError } from './api/client';
import { App } from './App';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Reintenta solo lo que tiene sentido reintentar (red o servidor caídos), no un 404 o un 400.
      retry: (failures, err) => failures < 2 && (!(err instanceof ApiError) || err.retryable),
      refetchOnWindowFocus: true,
      staleTime: 1000,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
