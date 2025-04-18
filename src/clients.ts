// Function to fetch client configuration from the database
export async function getClientConfig(env: Env, clientId: string): Promise<ClientConfig | null> {
    const result = await env.AUTH_DB.prepare(
      `
      SELECT redirect_uri, theme_title, theme_primary, theme_favicon, theme_logo_dark, theme_logo_light
      FROM clients
      WHERE client_id = ?;
      `
    )
      .bind(clientId)
      .first<{
        redirect_uri: string;
        theme_title: string;
        theme_primary: string;
        theme_favicon: string;
        theme_logo_dark: string;
        theme_logo_light: string;
      }>();
  
    if (!result) {
      return null;
    }
  
    return {
      redirect_uri: result.redirect_uri,
      theme: {
        title: result.theme_title,
        primary: result.theme_primary,
        favicon: result.theme_favicon,
        logo: {
          dark: result.theme_logo_dark,
          light: result.theme_logo_light,
        },
      },
    };
  }
  
  // Define the ClientConfig type
  interface ClientConfig {
    redirect_uri: string;
    theme: {
      title: string;
      primary: string;
      favicon: string;
      logo: {
        dark: string;
        light: string;
      };
    };
  }