const DATAFLOW_DEVICE_SESSION_ISSUER_ADAPTER_ID = "dataflow-device-session.v1";

function createDataFlowDeviceSessionIssuer({ challengeBroker } = {}) {
  if (typeof challengeBroker?.requestCredential !== "function") {
    throw new TypeError("dataflow_device_session_issuer_invalid");
  }
  return Object.freeze({
    adapterId: DATAFLOW_DEVICE_SESSION_ISSUER_ADAPTER_ID,
    issueCredentialLease: (grant, options) => challengeBroker.requestCredential(grant, options),
    revokeSubject: (actorSubjectDigest) => challengeBroker.revokeSubject(actorSubjectDigest),
  });
}

export { DATAFLOW_DEVICE_SESSION_ISSUER_ADAPTER_ID, createDataFlowDeviceSessionIssuer };
