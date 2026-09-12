import { requireSupabaseClient } from '@/src/services/supabase';

import type { AuthRequestResult } from '../types/auth';

function authenticationErrorMessage(message: string, action: 'sign-in' | 'sign-up'): string {
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedMessage.includes('invalid login credentials') ||
    normalizedMessage.includes('invalid email or password')
  ) {
    return 'Invalid email or password.';
  }

  if (normalizedMessage.includes('email') && normalizedMessage.includes('valid')) {
    return 'Please enter a valid email address.';
  }

  if (normalizedMessage.includes('email not confirmed')) {
    return 'Please confirm your email before signing in.';
  }

  if (
    normalizedMessage.includes('already registered') ||
    normalizedMessage.includes('already been registered')
  ) {
    return 'An account already exists for this email address. Try signing in instead.';
  }

  if (normalizedMessage.includes('password should be at least')) {
    return 'Choose a password with at least 8 characters.';
  }

  return action === 'sign-in'
    ? 'Unable to sign in. Please try again.'
    : 'Unable to create your account. Please try again.';
}

export async function signInWithEmail(email: string, password: string): Promise<AuthRequestResult> {
  const { error } = await requireSupabaseClient().auth.signInWithPassword({ email, password });

  if (error) {
    return { status: 'error', message: authenticationErrorMessage(error.message, 'sign-in') };
  }

  return { status: 'success' };
}

export async function signUpWithEmail(email: string, password: string): Promise<AuthRequestResult> {
  const { data, error } = await requireSupabaseClient().auth.signUp({ email, password });

  if (error) {
    return { status: 'error', message: authenticationErrorMessage(error.message, 'sign-up') };
  }

  return { status: 'success', requiresEmailConfirmation: !data.session };
}

export async function signOutCurrentUser(): Promise<AuthRequestResult> {
  const { error } = await requireSupabaseClient().auth.signOut();

  if (error) {
    return { status: 'error', message: 'Unable to sign out. Please try again.' };
  }

  return { status: 'success' };
}
