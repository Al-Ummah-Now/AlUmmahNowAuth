export async function getOrCreateUser(env: Env, email: string): Promise<string> {
    const result = await env.AUTH_DB.prepare(
      `
          INSERT INTO user (email)
          VALUES (?)
          ON CONFLICT (email) DO UPDATE SET email = email
          RETURNING id;
          `,
    )
      .bind(email)
      .first<{ id: string }>();
    if (!result) {
      throw new Error(`Unable to process user: ${email}`);
    }
    return result.id;
  }