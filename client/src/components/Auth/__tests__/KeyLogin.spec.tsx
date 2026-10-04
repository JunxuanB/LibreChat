import { fireEvent, render, screen } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import KeyLogin from '../KeyLogin';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const startupConfig = {
  appTitle: '氛围土豆',
  sub2api: { enabled: true, siteUrl: 'http://site.invalid' },
} as TStartupConfig;

describe('API Key login', () => {
  it('needs only a Key, hides it, and directs account management to the main site', () => {
    const login = jest.fn();
    render(<KeyLogin login={login} startupConfig={startupConfig} />);
    const input = screen.getByLabelText('com_auth_sub2api_key');
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', 'http://site.invalid/keys');
    fireEvent.change(input, { target: { value: ' test-key-a ' } });
    fireEvent.click(screen.getByRole('button'));
    expect(login).toHaveBeenCalledWith({ email: 'key@sub2api.invalid', password: 'test-key-a' });
    expect(screen.getByRole('button')).toBeDisabled();
    fireEvent.click(screen.getByRole('button'));
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('lets users correct and retry a rejected Key', () => {
    const login = jest.fn();
    render(<KeyLogin login={login} startupConfig={startupConfig} error="SUB2API_INVALID_KEY" />);
    fireEvent.change(screen.getByLabelText('com_auth_sub2api_key'), {
      target: { value: 'corrected-key' },
    });
    fireEvent.click(screen.getByRole('button'));
    expect(login).toHaveBeenCalledTimes(1);
  });
});
