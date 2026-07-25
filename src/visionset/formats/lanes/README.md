# `visionset.formats.lanes`

Reserved landing spot for the **audited v1 `lane_utils.py` port** (442 LOC + 91 tests),
arriving in an upcoming session. The v1 source is not in this repository — nothing here
is fabricated in the meantime.

When it lands, it will implement the `Importer`/`Exporter` ports from
`visionset.kernel.ports` and register in the `visionset.formats` entry-point group like
any other format plugin.
