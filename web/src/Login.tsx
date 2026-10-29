import { Button } from '@mieweb/ui/components/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@mieweb/ui/components/Card';
import { Input } from '@mieweb/ui/components/Input';

// A plain GET form: the server turns /?token= into a cookie and redirects back to /.
// A token still in the address bar means the server did not accept it.
export function Login() {
  const failed = new URLSearchParams(location.search).has('token');
  return (
    <main className="flex flex-1 items-center justify-center">
      <Card className="w-80">
        <form method="get" action="/">
          <CardHeader>
            <CardTitle>ozwell-computer</CardTitle>
            <CardDescription>Enter the access token to view this desktop.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Input type="password" name="token" label="Access token" hideLabel placeholder="token" autoComplete="current-password"
              autoFocus required hasError={failed} error={failed ? 'That token was not accepted.' : undefined} />
            <Button type="submit">Open</Button>
          </CardContent>
        </form>
      </Card>
    </main>
  );
}
