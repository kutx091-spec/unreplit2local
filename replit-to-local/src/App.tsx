import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import Home from '@/pages/home';
import { useEffect } from 'react';

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route>
        <div className="flex items-center justify-center min-h-screen text-muted-foreground font-mono">
          404 - Not Found
        </div>
      </Route>
    </Switch>
  );
}

function App() {
  useEffect(() => {
    // Force dark mode for that midnight terminal vibe
    document.documentElement.classList.add('dark');
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
