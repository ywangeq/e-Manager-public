import { useEffect, useState } from "react";

// Read projection only: Center owns schedules. No renderer timer or local persistence.
export function usePersonalAutomations(api, {authenticated, actorContextVersion, revision}) {
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    let current = true;
    if (!authenticated) {setSnapshot(null);return;}
    const refresh = async () => {
      try {
        const page = await api?.personalAutomations?.({action:"list"});
        if (current) setSnapshot({actorContextVersion,automations:page?.ok ? page.automations || [] : []});
      } catch {if (current) setSnapshot(null);}
    };
    void refresh();
    window.addEventListener("focus",refresh);
    return () => {current=false;window.removeEventListener("focus",refresh);};
  },[api,authenticated,actorContextVersion,revision]);
  return authenticated && snapshot?.actorContextVersion === actorContextVersion ? snapshot.automations : [];
}
