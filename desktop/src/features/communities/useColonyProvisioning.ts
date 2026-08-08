import * as React from "react";

import {
  type ColonyProvisioning,
  PROVISIONING_PENDING,
  PROVISIONING_UNREACHABLE,
  provisioningFromConfig,
} from "@/features/communities/colonyProvisioning";
import { fetchColonyProvisioningConfig } from "@/features/communities/hostedCommunityApi";

/**
 * Reads the connected relay's provisioning surface.
 *
 * The create form used to hardcode `colony.ainative.ventures`, so it printed
 * the production address on every relay — including a local dev relay that
 * fails every create with a 404. The suffix now comes from whichever relay the
 * app is actually connected to, and is simply absent until that answer lands
 * rather than guessed at.
 */
export function useColonyProvisioning(): ColonyProvisioning {
  const [state, setState] =
    React.useState<ColonyProvisioning>(PROVISIONING_PENDING);

  React.useEffect(() => {
    let active = true;
    void fetchColonyProvisioningConfig()
      .then((config) => {
        if (active) setState(provisioningFromConfig(config));
      })
      .catch(() => {
        // An older relay has no /api/communities/config and 404s here. Treat
        // it the same as unreachable: we do not know the domain, so we must
        // not print one.
        if (active) setState(PROVISIONING_UNREACHABLE);
      });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
