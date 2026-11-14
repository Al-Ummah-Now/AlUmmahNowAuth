/**
 * Users > System accounts (super admins only): the accounts the user list leaves
 * out, read-only, with their status and every role row. A system account must
 * hold no role; one that does is shown as an alert (lib/system-accounts.ts).
 */
import { Bot } from "lucide-react";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { dirOf, type AdminLang } from "../lib/deletion-copy";
import { systemAccountsCopy } from "../lib/system-accounts";

export interface SystemAccountRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  deleted_at: number | null;
  roles: Array<{ id: string; name: string }>;
}

export function SystemAccountsSection({ accounts, lang }: { accounts: SystemAccountRow[]; lang: AdminLang }) {
  const t = systemAccountsCopy(lang);
  return (
    <Card id="system-accounts" data-testid="system-accounts" dir={dirOf(lang)} lang={lang} className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" aria-hidden="true" />
          {t.title}
        </CardTitle>
        <CardDescription>{t.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {accounts.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">{t.empty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.email}</TableHead>
                <TableHead>{t.name}</TableHead>
                <TableHead>{t.status}</TableHead>
                <TableHead>{t.roles}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => (
                <TableRow key={a.id} data-testid={`system-account-${a.id}`}>
                  <TableCell>
                    <div className="font-medium" dir="ltr">{a.email}</div>
                    <div className="font-mono text-xs text-[var(--color-muted-foreground)]" dir="ltr">{a.id}</div>
                  </TableCell>
                  <TableCell>{a.name ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{a.status}{a.deleted_at ? ` · ${t.deleted}` : ""}</Badge>
                      <Badge variant="outline" data-testid="cant-sign-in">{t.cantSignIn}</Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    {a.roles.length === 0 ? (
                      <span className="text-sm text-[var(--color-muted-foreground)]" data-testid="no-roles">{t.noRoles}</span>
                    ) : (
                      <div className="space-y-1" role="alert">
                        <div className="flex flex-wrap gap-1">
                          {a.roles.map((r) => (
                            <Badge key={r.id} variant="destructive">{r.name}</Badge>
                          ))}
                        </div>
                        <p className="text-xs text-[var(--color-destructive-text)]">{t.roleAlert}</p>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
