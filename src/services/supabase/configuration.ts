const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();

type SupabaseVariableName = 'EXPO_PUBLIC_SUPABASE_URL' | 'EXPO_PUBLIC_SUPABASE_ANON_KEY';

export type SupabaseConfiguration =
  | {
      status: 'configured';
      url: string;
      anonKey: string;
    }
  | {
      status: 'unconfigured';
      missingVariables: readonly SupabaseVariableName[];
    }
  | {
      status: 'invalid';
      message: string;
    };

function readSupabaseConfiguration(): SupabaseConfiguration {
  const missingVariables: SupabaseVariableName[] = [];

  if (!supabaseUrl) {
    missingVariables.push('EXPO_PUBLIC_SUPABASE_URL');
  }

  if (!supabaseAnonKey) {
    missingVariables.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    return { status: 'unconfigured', missingVariables };
  }

  try {
    const parsedUrl = new URL(supabaseUrl);

    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return {
        status: 'invalid',
        message: 'EXPO_PUBLIC_SUPABASE_URL must use the http or https protocol.',
      };
    }
  } catch {
    return {
      status: 'invalid',
      message: 'EXPO_PUBLIC_SUPABASE_URL must be a valid URL.',
    };
  }

  return { status: 'configured', url: supabaseUrl, anonKey: supabaseAnonKey };
}

export const supabaseConfiguration = readSupabaseConfiguration();
