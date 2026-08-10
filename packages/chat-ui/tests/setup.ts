// React needs this to treat `act` as supported. Harmless in the node-environment
// suites, which never load React at all.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
