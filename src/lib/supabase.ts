import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY!; // Isso é uma KEY de Service Role/Admin, perigoso.

if (!supabaseUrl || !supabaseKey) {
    throw new Error('🛡️ SECURITY HALT: SUPABASE_URL e SUPABASE_SECRET_KEY(service_role) são obrigatórios no .env');
}

// Renomeado para supabaseAdmin para deixar CRISTALINO que este client tem privilégios de ROOT e quebra o RLS (Row Level Security).
export const supabaseAdmin = createClient(supabaseUrl, supabaseKey);
