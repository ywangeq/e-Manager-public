import { useEffect, useState } from "react";
import ManagementConsole from "./components/ManagementConsole";
import Portal from "./components/Portal";
import { currentSession, enterpriseLoginUrl, fetchEnterpriseSession, login, logout } from "./lib/auth";

export default function App() {
  const [session, setSession] = useState(() => currentSession());
  const [isCheckingSession, setIsCheckingSession] = useState(true);

  useEffect(() => {
    let isMounted = true;

    fetchEnterpriseSession().then((enterpriseSession) => {
      if (!isMounted) return;
      setSession(enterpriseSession);
      setIsCheckingSession(false);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleLogin(email, password) {
    const result = await login(email, password);
    if (result.ok) setSession(result.session);
    return result;
  }

  async function handleLogout() {
    await logout();
    setSession(null);
  }

  if (isCheckingSession) return null;
  if (!session) return <Portal enterpriseLoginUrl={enterpriseLoginUrl()} onLogin={handleLogin} />;
  return <ManagementConsole session={session} onLogout={handleLogout} />;
}
