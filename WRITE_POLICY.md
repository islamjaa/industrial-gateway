# PLC write policy

Manual PLC writes require global write support plus explicit write permission on both the device and target physical tag. Calculated tags cannot be physical write targets. Values are converted and validated against the target type and supported address area. The UI requires a confirmation step for manual writes.

Automatic expression write-back is configured on the calculated tag: enable automatic output, select a physical target, and set the minimum interval. The catalog rejects unknown targets and dependency cycles. The poller writes only GOOD calculated results and avoids repeating the same successful value. A driver acknowledgement is logged as an acknowledgement, not as proof that the PLC program retained the value. This build does not guarantee an automatic read-back verification for every protocol.

Start with a non-critical variable and coordinate with the PLC owner before enabling writes in a production process.
