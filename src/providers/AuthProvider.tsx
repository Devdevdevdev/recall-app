import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import type { Session } from '@supabase/supabase-js';

import {
  signInWithEmail,
  signOutCurrentUser,
  signUpWithEmail,
} from '@/src/features/auth/services/authService';
import type { AuthRequestResult, AuthSession, AuthUser } from '@/src/features/auth/types/auth';
import {
  supabaseClient,
  supabaseConfiguration,
  type SupabaseConfiguration,
} from '@/src/services/supabase';

type AuthContextValue = {
  configuration: AuthConfigurationState;
  isAuthenticated: boolean;
  isLoading: boolean;
  session: AuthSession | null;
  signIn: (email: string, password: string) => Promise<AuthRequestResult>;
  signOut: () => Promise<AuthRequestResult>;
  signUp: (email: string, password: string) => Promise<AuthRequestResult>;
  user: AuthUser | null;
};

type AuthConfigurationState =
  { status: 'configured' } | Exclude<SupabaseConfiguration, { status: 'configured' }>;

const AuthContext = createContext<AuthContextValue | null>(null);

function toAuthSession(session: Session | null): AuthSession | null {
  if (!session) {
    return null;
  }

  return { user: { email: session.user.email ?? null } };
}

function toAuthConfigurationState(configuration: SupabaseConfiguration): AuthConfigurationState {
  if (configuration.status === 'configured') {
    return { status: 'configured' };
  }

  return configuration;
}

const authConfigurationState = toAuthConfigurationState(supabaseConfiguration);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [isLoading, setIsLoading] = useState(supabaseClient !== null);

  useEffect(() => {
    if (!supabaseClient) {
      return;
    }

    let isMounted = true;
    const {
      data: { subscription },
    } = supabaseClient.auth.onAuthStateChange((_event, nextSession) => {
      if (isMounted) {
        setSession(toAuthSession(nextSession));
        setIsLoading(false);
      }
    });

    void supabaseClient.auth.getSession().then(({ data }) => {
      if (isMounted) {
        setSession(toAuthSession(data.session));
        setIsLoading(false);
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(
    (email: string, password: string) => signInWithEmail(email, password),
    [],
  );
  const signUp = useCallback(
    (email: string, password: string) => signUpWithEmail(email, password),
    [],
  );
  const signOut = useCallback(() => signOutCurrentUser(), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      configuration: authConfigurationState,
      isAuthenticated: session !== null,
      isLoading,
      session,
      signIn,
      signOut,
      signUp,
      user: session?.user ?? null,
    }),
    [isLoading, session, signIn, signOut, signUp],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }

  return context;
}
