import { ErrorTypes } from 'librechat-data-provider';
import { TranslationKeys } from '~/hooks';

const getLoginError = (errorText: string): TranslationKeys => {
  const defaultError: TranslationKeys = 'com_auth_error_login';

  if (!errorText) {
    return defaultError;
  }

  switch (true) {
    case errorText === 'SUB2API_INVALID_KEY':
      return 'com_auth_sub2api_invalid';
    case errorText === 'SUB2API_UNAVAILABLE':
      return 'com_auth_sub2api_unavailable';
    case errorText === ErrorTypes.AUTH_CROSS_ORIGIN:
      return 'com_auth_error_login_cross_origin';
    case errorText.includes('429'):
      return 'com_auth_error_login_rl';
    case errorText.includes('403'):
      return 'com_auth_error_login_ban';
    case errorText.includes('500'):
      return 'com_auth_error_login_server';
    case errorText.includes('422'):
      return 'com_auth_error_login_unverified';
    default:
      return defaultError;
  }
};

export default getLoginError;
