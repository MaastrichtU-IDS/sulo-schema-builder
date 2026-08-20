import { useContext } from 'react';
import { AuthContext, type AuthContextValue } from './AuthProvider.js';

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
