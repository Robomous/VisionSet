# usage: from visionset.formats.cvat._document import parse, Shapes
"""What both CVAT 1.1 dialects read and write the same way.

Private to :mod:`visionset.formats.cvat`. A document is parsed by expat
directly, so every element keeps the line it starts on for a refusal to name,
and a ``DOCTYPE`` or entity declaration is refused before anything expands:
CVAT never writes one.
"""

from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ElementTree
import xml.parsers.expat as expat
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, Literal

from pydantic import ValidationError

from visionset.formats._reading import files_under, number
from visionset.kernel.domain import (
    BboxGeometry,
    GeometryType,
    ImportedClass,
    ImportLossKind,
    LabelClass,
    ManifestAnnotation,
    PolygonGeometry,
    PolylineGeometry,
)
from visionset.kernel.domain.schema import Attribute, AttributeValue
from visionset.kernel.errors import ExportSourceUnreadable, ImportSourceUnreadable

DOCUMENT_FILENAME: Final = "annotations.xml"
IMAGES_DIRNAME: Final = "images"
VERSION: Final = "1.1"

#: The shape elements whose geometry the domain holds, and what each becomes.
DRAWN: Final[Mapping[str, GeometryType]] = {
    "box": GeometryType.BBOX,
    "polygon": GeometryType.POLYGON,
    "polyline": GeometryType.POLYLINE,
}
#: CVAT shapes the domain has no geometry for.
UNDRAWN: Final = frozenset({"points", "ellipse", "cuboid", "mask", "skeleton"})
SHAPES: Final = frozenset(DRAWN) | UNDRAWN

#: A label's ``<type>`` as CVAT names it, for each geometry the exporters write.
LABEL_TYPES: Final[Mapping[GeometryType, str]] = {
    GeometryType.BBOX: "rectangle",
    GeometryType.POLYGON: "polygon",
    GeometryType.POLYLINE: "polyline",
    GeometryType.CLASSIFICATION_TAG: "tag",
}
_TYPED: Final = {name: geometry for geometry, name in LABEL_TYPES.items()}

_INPUT_TYPES: Final = {
    "string": "text",
    "number": "number",
    "boolean": "checkbox",
    "select": "select",
}
#: Each CVAT ``input_type`` as the attribute kind it reads as; ``radio`` is a select.
_KINDS: Final[Mapping[str, Literal["string", "number", "boolean", "select"]]] = {
    "text": "string",
    "number": "number",
    "checkbox": "boolean",
    "select": "select",
    "radio": "select",
}

#: VisionSet provenance as CVAT's ``source`` names it: ``file`` is CVAT's own word
#: for a shape imported from an annotation file.
SOURCES: Final = {"human": "manual", "model": "auto", "import": "file"}

#: Attributes every shape may carry that the importers read or report themselves.
_SHAPE_ATTRIBUTES: Final = frozenset(
    {"label", "source", "occluded", "z_order", "group_id", "rotation", "points"}
    | {"xtl", "ytl", "xbr", "ybr"}
)
_FLAG: Final = re.compile(r"[01]")
_INTEGER: Final = re.compile(r"[+-]?\d{1,9}", re.ASCII)
_ROTATION: Final = "a rotated box has no canonical geometry; it is not imported"
_OCCLUDED: Final = "occluded is not carried; the shape is kept"
_Z_ORDER: Final = "z_order is not carried; the shape is kept"
_GROUP: Final = "group_id is not carried; the shape is kept"
UNLABELLED: Final = "unlabelled"
_NO_GEOMETRY: Final = (
    "no imported shape and no label <type> gives it a geometry the domain holds; "
    "the class is not imported"
)
#: What XML 1.0 cannot hold at all, escaped or not.
_UNWRITABLE: Final = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")
_UNLABELLED: Final = "a shape with an empty label has no class; it is not imported"

Losses = Counter[tuple[ImportLossKind, str, str]]


class _Declared(Exception):
    pass


def _refuse(*_: object) -> None:
    raise _Declared


@dataclass
class Document:
    """One parsed ``annotations.xml``, its elements' lines, and where it is."""

    root: ElementTree.Element
    where: str
    lines: dict[ElementTree.Element, int] = field(default_factory=dict)

    def at(self, element: ElementTree.Element) -> str:
        return f"{self.where} line {self.lines.get(element, 0)}"

    def refuse(self, element: ElementTree.Element, why: str) -> ImportSourceUnreadable:
        return ImportSourceUnreadable(f"{self.at(element)}: {why}")


def documents(src: Path, what: str) -> list[Path]:
    """Every ``annotations.xml`` under the source, refused when there is none."""
    if not src.is_dir():
        raise ImportSourceUnreadable(f"the {what} source {src.name!r} is not a directory")
    found = [path for path in files_under(src, src, {".xml"}) if path.name == DOCUMENT_FILENAME]
    if not found:
        raise ImportSourceUnreadable(f"the {what} source {src.name!r} holds no {DOCUMENT_FILENAME}")
    return found


def parse(path: Path, where: str) -> Document:
    """The document, refused when it is not CVAT 1.1 XML or declares a DOCTYPE or entity."""
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ImportSourceUnreadable(f"{where} could not be read: {exc}") from None
    parser = expat.ParserCreate()
    parser.buffer_text = True
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    parser.StartDoctypeDeclHandler = _refuse
    parser.EntityDeclHandler = _refuse
    lines: dict[ElementTree.Element, int] = {}
    stack: list[ElementTree.Element] = []
    roots: list[ElementTree.Element] = []

    def start(tag: str, attributes: dict[str, str]) -> None:
        element = (
            ElementTree.SubElement(stack[-1], tag, attributes)
            if stack
            else ElementTree.Element(tag, attributes)
        )
        if not stack:
            roots.append(element)
        lines[element] = parser.CurrentLineNumber
        stack.append(element)

    def end(_: str) -> None:
        stack.pop()

    def text(data: str) -> None:
        if stack:
            current = stack[-1]
            if len(current):
                current[-1].tail = (current[-1].tail or "") + data
            else:
                current.text = (current.text or "") + data

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    try:
        parser.Parse(raw, True)
    except _Declared:
        raise ImportSourceUnreadable(
            f"{where} line {parser.CurrentLineNumber} declares a DOCTYPE or an entity, "
            "which a CVAT document never needs"
        ) from None
    except (expat.ExpatError, ValueError) as exc:
        raise ImportSourceUnreadable(f"{where} is not readable XML: {exc}") from None
    (root,) = roots
    document = Document(root=root, where=where, lines=lines)
    if root.tag != "annotations":
        raise document.refuse(root, f"the root is <{root.tag}>, not a CVAT <annotations>")
    version = (root.findtext("version") or "").strip()
    if version != VERSION:
        raise document.refuse(
            root,
            f"the document's version is {version or 'not given'}; CVAT XML {VERSION} is read",
        )
    return document


@dataclass(frozen=True)
class Meta:
    """What a document's ``<meta>`` declares: its labels in order and their attributes,
    and its task's fields."""

    labels: tuple[str, ...]
    label_types: Mapping[str, GeometryType]
    task: ElementTree.Element | None
    project: bool
    attributes: Mapping[str, tuple[Attribute, ...]] = field(default_factory=dict)

    def definitions(self, label: str) -> dict[str, Attribute]:
        return {attribute.name: attribute for attribute in self.attributes.get(label, ())}


def meta(document: Document, losses: Losses) -> Meta:
    """The labels every ``<meta>/<task|job|project>/<labels>`` declares, each once."""
    labels: list[str] = []
    types: dict[str, GeometryType] = {}
    attributes: dict[str, tuple[Attribute, ...]] = {}
    task = None
    project = False
    container = document.root.find("meta")
    for owner in () if container is None else container:
        if owner.tag in ("task", "job") and task is None:
            task = owner
        project = project or owner.tag == "project"
        for label in owner.findall("labels/label"):
            if (label.findtext("parent") or "").strip():
                continue
            name = (label.findtext("name") or "").strip()
            if not name:
                raise document.refuse(label, "a <label> has no name")
            if name in labels:
                raise document.refuse(label, f"label {name!r} is declared twice")
            labels.append(name)
            typed = _TYPED.get((label.findtext("type") or "").strip())
            if typed is not None:
                types[name] = typed
            attributes[name] = _attribute_specs(document, label, name, losses)
    return Meta(
        labels=tuple(labels), label_types=types, task=task, project=project, attributes=attributes
    )


def _attribute_specs(
    document: Document, label: ElementTree.Element, name: str, losses: Losses
) -> tuple[Attribute, ...]:
    specs: dict[str, Attribute] = {}
    for spec in label.findall("attributes/attribute"):
        one = _attribute_spec(document, spec, name, losses)
        if one is None:
            continue
        if one.name.casefold() in specs:
            reason = f"attribute {one.name[:40]!r} is defined twice; the first definition is kept"
            losses[(ImportLossKind.ATTRIBUTE, name, reason)] += 1
            continue
        specs[one.name.casefold()] = one
    return tuple(specs.values())


def _attribute_spec(
    document: Document, spec: ElementTree.Element, label: str, losses: Losses
) -> Attribute | None:
    """One ``<attribute>`` definition as an attribute, or ``None`` with its loss counted.

    CVAT has no required attribute, so none is. A ``number``'s range and step
    have no place in a definition and are a loss; the attribute is kept.
    """
    name = (spec.findtext("name") or "").strip()
    if not name:
        raise document.refuse(spec, "an attribute definition has no name")
    shown = repr(name[:40])
    input_type = (spec.findtext("input_type") or "").strip()
    kind = _KINDS.get(input_type)
    if kind is None:
        reason = (
            f"attribute {shown} is a {input_type[:40] or 'untyped'} input, which is not imported"
        )
        losses[(ImportLossKind.ATTRIBUTE, label, reason)] += 1
        return None
    values = [value for value in (spec.findtext("values") or "").split("\n") if value]
    options = None
    if kind == "select":
        options = tuple(dict.fromkeys(values))
        if not options:
            reason = f"attribute {shown} is a select with no values; it is not imported"
            losses[(ImportLossKind.ATTRIBUTE, label, reason)] += 1
            return None
    elif kind == "number" and values:
        reason = f"attribute {shown}'s range and step are not carried; the attribute is kept"
        losses[(ImportLossKind.ATTRIBUTE, label, reason)] += 1
    declared = Attribute(name=name, kind=kind, options=options)
    default_text = spec.findtext("default_value") or ""
    if not default_text:
        return declared
    default = attribute_value(declared, default_text)
    if declared.rejects(default) is not None:
        reason = f"attribute {shown}'s default is not one it accepts; the default is not imported"
        losses[(ImportLossKind.ATTRIBUTE, label, reason)] += 1
        return declared
    return declared.model_copy(update={"default": default})


def attribute_value(definition: Attribute | None, text: str) -> AttributeValue:
    """The text CVAT writes for a value, as the kind ``definition`` declares.

    Text that does not read as that kind is answered as it is, for the import
    to judge against the schema its label lands under.
    """
    if definition is None or definition.kind in ("string", "select"):
        return text
    token = text.strip()
    if definition.kind == "boolean":
        return token.lower() == "true" if token.lower() in ("true", "false") else text
    try:
        value = float(token)
    except ValueError:
        return text
    return value if math.isfinite(value) else text


def flag(document: Document, element: ElementTree.Element, name: str, default: str) -> bool:
    value = element.get(name, default).strip()
    if not _FLAG.fullmatch(value):
        raise document.refuse(element, f"{name} is {value!r}, not 0 or 1")
    return value == "1"


def integer(
    document: Document, element: ElementTree.Element, name: str, *, minimum: int = 0
) -> int:
    value = element.get(name)
    if value is None:
        raise document.refuse(element, f"<{element.tag}> gives no {name}")
    if not _INTEGER.fullmatch(value.strip()) or int(value) < minimum:
        raise document.refuse(element, f"{name} {value!r} is not an integer of at least {minimum}")
    return int(value)


def label_of(
    document: Document, element: ElementTree.Element, declared: Meta, losses: Losses
) -> str | None:
    """The shape's label, or ``None`` with a loss when it has none, as Datumaro writes one."""
    if "label" not in element.attrib:
        raise document.refuse(element, f"<{element.tag}> names no label")
    name = element.attrib["label"].strip()
    if not name:
        losses[(ImportLossKind.LABEL, UNLABELLED, _UNLABELLED)] += 1
        return None
    if declared.labels and name not in declared.labels:
        raise document.refuse(element, f"label {name!r} is not one the document's <meta> declares")
    return name


def _coordinate(document: Document, element: ElementTree.Element, name: str) -> float:
    token = (element.get(name) or "").strip()
    value = number(token, document.at(element))
    if value is None:
        raise document.refuse(element, f"{name} {token!r} is not a number")
    return value


def _points(document: Document, element: ElementTree.Element) -> list[tuple[float, float]]:
    text = (element.get("points") or "").strip()
    points = []
    for pair in text.split(";") if text else []:
        values = pair.split(",")
        parsed = [number(value.strip(), document.at(element)) for value in values]
        if len(parsed) != 2 or parsed[0] is None or parsed[1] is None:
            raise document.refuse(element, f"points {pair!r} is not an x,y pair")
        points.append((parsed[0], parsed[1]))
    return points


def geometry(
    document: Document, element: ElementTree.Element, losses: Losses, label: str
) -> BboxGeometry | PolygonGeometry | PolylineGeometry | None:
    """The shape's canonical geometry, or ``None`` with its loss counted."""
    if element.tag in UNDRAWN:
        losses[
            (
                ImportLossKind.LABEL,
                label,
                f"a CVAT <{element.tag}> has no canonical geometry; it is not imported",
            )
        ] += 1
        return None
    try:
        if element.tag == "box":
            rotation = element.get("rotation")
            if rotation is not None and _coordinate(document, element, "rotation") % 360 != 0:
                losses[(ImportLossKind.LABEL, label, _ROTATION)] += 1
                return None
            left, top, right, bottom = (
                _coordinate(document, element, name) for name in ("xtl", "ytl", "xbr", "ybr")
            )
            if right <= left or bottom <= top:
                raise document.refuse(element, "the box has no area")
            return BboxGeometry(x=left, y=top, width=right - left, height=bottom - top)
        points = _points(document, element)
        if element.tag == "polygon":
            if len(points) < 3:
                raise document.refuse(element, "a polygon needs at least three points")
            return PolygonGeometry(points=points)
        if len(points) < 2:
            raise document.refuse(element, "a polyline needs at least two points")
        return PolylineGeometry(points=points)
    except ValidationError as exc:
        raise document.refuse(element, str(exc.errors()[0]["msg"])) from None


def extras(
    document: Document,
    element: ElementTree.Element,
    losses: Losses,
    label: str,
    declared: Meta,
    read: frozenset[str] = frozenset(),
) -> dict[str, AttributeValue]:
    """The shape's attribute values, counting what else it carries that the domain cannot hold."""
    if flag(document, element, "occluded", "0"):
        losses[(ImportLossKind.ATTRIBUTE, label, _OCCLUDED)] += 1
    z_order = element.get("z_order")
    if z_order is not None and integer(document, element, "z_order", minimum=-(10**9)) != 0:
        losses[(ImportLossKind.ATTRIBUTE, label, _Z_ORDER)] += 1
    if element.get("group_id") not in (None, "", "0"):
        losses[(ImportLossKind.ATTRIBUTE, label, _GROUP)] += 1
    for name in sorted(set(element.keys()) - _SHAPE_ATTRIBUTES - read):
        losses[(ImportLossKind.ATTRIBUTE, label, f"the {name[:40]} field is not imported")] += 1
    definitions = declared.definitions(label)
    values: dict[str, AttributeValue] = {}
    for child in element:
        if child.tag == "attribute":
            name = (child.get("name") or "").strip()
            if not name:
                raise document.refuse(child, "an <attribute> has no name")
            if name in values:
                reason = f"attribute {name[:40]!r} is given twice on one shape; the first is kept"
                losses[(ImportLossKind.ATTRIBUTE, label, reason)] += 1
                continue
            values[name] = attribute_value(definitions.get(name), child.text or "")
        else:
            losses[(ImportLossKind.ATTRIBUTE, label, f"<{child.tag[:40]}> is not imported")] += 1
    return values


def imported_classes(
    declared: Iterable[Meta],
    used: Mapping[str, set[GeometryType]],
    losses: Losses,
) -> list[ImportedClass]:
    """Every class a document declares or a label uses, in declaration order.

    A class takes the geometries its labels use. A declared label no shape uses
    is a class only when its ``<type>`` names a geometry the domain holds; CVAT's
    ``any`` names none, and a label left with no geometry is a ``class`` loss.
    A class takes each attribute from the first document defining it; another
    defining it differently is an ``attribute`` loss.
    """
    order: dict[str, None] = {}
    typed: dict[str, GeometryType] = {}
    attributes: dict[str, dict[str, Attribute]] = {}
    for one in declared:
        order.update(dict.fromkeys(one.labels))
        typed.update(one.label_types)
        for label, specs in one.attributes.items():
            merged = attributes.setdefault(label, {})
            for spec in specs:
                if merged.setdefault(spec.name.casefold(), spec) != spec:
                    reason = (
                        f"attribute {spec.name[:40]!r} is defined differently by two documents; "
                        "the first definition is kept"
                    )
                    losses[(ImportLossKind.ATTRIBUTE, label, reason)] += 1
    order.update(dict.fromkeys(used))
    classes = []
    for name in order:
        geometries = used.get(name) or ({typed[name]} if name in typed else set())
        if geometries:
            classes.append(
                ImportedClass(
                    name=name,
                    geometries=tuple(geometries),
                    attributes=tuple(attributes.get(name, {}).values()),
                )
            )
        else:
            losses[(ImportLossKind.CLASS, name, _NO_GEOMETRY)] += 1
    return classes


# --- writing ------------------------------------------------------------------


def text_of(value: AttributeValue) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float | int):
        return format_number(value)
    return value


def format_number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def new_document() -> ElementTree.Element:
    root = ElementTree.Element("annotations")
    ElementTree.SubElement(root, "version").text = VERSION
    return root


def write_meta(
    root: ElementTree.Element,
    *,
    name: str,
    size: int,
    mode: str,
    classes: Iterable[LabelClass],
    original_size: tuple[int, int] | None = None,
    mutable: bool = False,
) -> None:
    task = ElementTree.SubElement(ElementTree.SubElement(root, "meta"), "task")
    for key, value in (
        ("name", name),
        ("size", str(size)),
        ("mode", mode),
        ("overlap", "0"),
        ("start_frame", "0"),
        ("stop_frame", str(max(size - 1, 0))),
    ):
        ElementTree.SubElement(task, key).text = value
    labels = ElementTree.SubElement(task, "labels")
    for one in classes:
        label = ElementTree.SubElement(labels, "label")
        ElementTree.SubElement(label, "name").text = one.name
        types = {LABEL_TYPES[g] for g in one.geometries if g in LABEL_TYPES}
        ElementTree.SubElement(label, "type").text = types.pop() if len(types) == 1 else "any"
        attributes = ElementTree.SubElement(label, "attributes")
        for attribute in one.attributes:
            _write_attribute_spec(attributes, attribute, mutable)
    if original_size is not None:
        sized = ElementTree.SubElement(task, "original_size")
        ElementTree.SubElement(sized, "width").text = str(original_size[0])
        ElementTree.SubElement(sized, "height").text = str(original_size[1])


def _write_attribute_spec(into: ElementTree.Element, attribute: Attribute, mutable: bool) -> None:
    spec = ElementTree.SubElement(into, "attribute")
    ElementTree.SubElement(spec, "name").text = attribute.name
    ElementTree.SubElement(spec, "mutable").text = str(mutable)
    ElementTree.SubElement(spec, "input_type").text = _INPUT_TYPES[attribute.kind]
    for option in attribute.options or ():
        if not option or "\n" in option:
            raise ExportSourceUnreadable(
                f"attribute {attribute.name[:40]!r} has the option {option[:40]!r}; a CVAT "
                "option is one non-empty line of <values>, so it cannot be written"
            )
    default = "" if attribute.default is None else text_of(attribute.default)
    ElementTree.SubElement(spec, "default_value").text = default
    values = "\n".join(attribute.options or ())
    if attribute.kind == "boolean":
        values = "false\ntrue"
    ElementTree.SubElement(spec, "values").text = values


def write_shape(
    into: ElementTree.Element,
    annotation: ManifestAnnotation,
    fields: Mapping[str, str],
    *,
    with_attributes: bool = True,
) -> ElementTree.Element:
    """One shape element of the annotation's geometry, after ``fields`` that lead it."""
    shape = annotation.geometry
    attributes = dict(fields)
    attributes["occluded"] = attributes.get("occluded", "0")
    if isinstance(shape, BboxGeometry):
        tag_name = "box"
        attributes |= {
            "xtl": format_number(shape.x),
            "ytl": format_number(shape.y),
            "xbr": format_number(shape.x + shape.width),
            "ybr": format_number(shape.y + shape.height),
        }
    elif isinstance(shape, PolygonGeometry | PolylineGeometry):
        tag_name = "polygon" if isinstance(shape, PolygonGeometry) else "polyline"
        attributes["points"] = ";".join(
            f"{format_number(x)},{format_number(y)}" for x, y in shape.points
        )
    else:
        raise ExportSourceUnreadable(
            f"annotation {annotation.id} is a {shape.type.value}, which a CVAT shape cannot be"
        )
    attributes["z_order"] = "0"
    element = ElementTree.SubElement(into, tag_name, attributes)
    if with_attributes:
        write_values(element, annotation)
    return element


def write_values(element: ElementTree.Element, annotation: ManifestAnnotation) -> None:
    for name, value in sorted(annotation.attributes.items()):
        ElementTree.SubElement(element, "attribute", {"name": name}).text = text_of(value)


def require_writable(root: ElementTree.Element) -> None:
    """Refuse text XML 1.0 cannot carry, before anything of the export is written."""
    for element in root.iter():
        for value in (element.text or "", *element.attrib.values()):
            if _UNWRITABLE.search(value):
                raise ExportSourceUnreadable(
                    f"{value[:40]!r} holds a control character XML cannot carry, "
                    "so no CVAT document can name it"
                )


def save(root: ElementTree.Element, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    ElementTree.indent(root, space="  ")
    ElementTree.ElementTree(root).write(target, encoding="utf-8", xml_declaration=True)
