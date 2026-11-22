import pytest


from vision_worker.vision_identifier import (
    InspectionError,
    VisualInspection,
    _validate_image_url,
    VisionTreasureInspector,
)


def test_only_allowlisted_https_hosts_are_accepted():
    assert _validate_image_url(
        "https://images.example.org/item.jpg", {"images.example.org"}
    ) == "images.example.org"


@pytest.mark.parametrize("url", [
    "http://images.example.org/item.jpg",
    "https://127.0.0.1/private.jpg",
    "https://user:pass@images.example.org/item.jpg",
    "https://images.example.org:8443/item.jpg",
    "file:///etc/passwd",
])
def test_unsafe_image_urls_are_rejected(url):
    with pytest.raises(InspectionError):
        _validate_image_url(url, {"images.example.org"})


def test_visual_result_is_bounded_and_explicitly_uncertain():
    result = VisualInspection(
        identified=False,
        exact_model="Unbekannt",
        visual_authenticity_score=0.1,
        condition_grade="Unklar",
        uncertainty_notes=["Typenschild nicht lesbar"],
    )
    assert result.visual_authenticity_score == 0.1
    assert result.identified is False


def test_visual_score_out_of_range_is_rejected():
    with pytest.raises(Exception):
        VisualInspection(
            identified=True,
            visual_authenticity_score=1.2,
        )


@pytest.mark.asyncio
async def test_injected_clients_remain_owned_by_the_caller():
    class FakeOpenAIClient:
        closed = False

        async def close(self):
            self.closed = True

    llm = FakeOpenAIClient()
    inspector = VisionTreasureInspector(client=llm, allowed_hosts={"images.example.org"})

    await inspector.close()

    assert llm.closed is False
